package deployment

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"time"
)

type backupEntry struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type backupMetadata struct {
	Format         string                 `json:"format"`
	Version        string                 `json:"version"`
	ReleaseSHA512  string                 `json:"release_sha512"`
	PostgresMajor  int                    `json:"postgres_major"`
	CreatedAt      string                 `json:"created_at"`
	Maintenance    maintenanceSnapshot    `json:"maintenance"`
	TLSFingerprint string                 `json:"tls_fingerprint"`
	Views          map[string]publicView  `json:"public_views"`
	Files          map[string]backupEntry `json:"files"`
}

var backupFiles = map[string]int64{"backup.json": 1 << 20, "database.dump": 128 << 30, "roles.json": 1 << 20, ".env": 1 << 20, "tls/server.pem": 1 << 20, "tls/server.key": 1 << 20, "secrets/provider-credential-master.key": 32, "secrets/absent": 0}

func hashBytes(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func fileHash(path string) (backupEntry, error) {
	var result backupEntry
	f, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer f.Close()
	h := sha256.New()
	result.Size, err = io.Copy(h, f)
	if err != nil {
		return result, err
	}
	result.SHA256 = hex.EncodeToString(h.Sum(nil))
	return result, nil
}
func writeBackupMetadata(stage string, m backupMetadata) error {
	m.Files = map[string]backupEntry{}
	for name := range backupFiles {
		if name == "backup.json" {
			continue
		}
		e, err := fileHash(filepath.Join(stage, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		m.Files[name] = e
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(stage, "backup.json"), b, 0600)
}
func validateBackupStage(stage string, r verifiedRuntime) ([]byte, backupMetadata, error) {
	var m backupMetadata
	b, err := os.ReadFile(filepath.Join(stage, "backup.json"))
	if err != nil {
		return b, m, err
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if d.Decode(&m) != nil {
		return b, m, errors.New("invalid backup metadata")
	}
	canonical, e := json.Marshal(m)
	if e != nil || !bytes.Equal(b, canonical) {
		return b, m, errors.New("noncanonical backup metadata")
	}
	if m.Format != "nevix-instance-backup-v1" || m.Version != r.manifest.Version || m.ReleaseSHA512 != r.manifest.SHA512 || m.PostgresMajor != 17 || !m.Maintenance.Paused || !m.Maintenance.Drained || m.Maintenance.NonTerminal != 0 || m.Maintenance.Owner == nil || m.Maintenance.Revision < 1 {
		return b, m, errors.New("backup release or drained maintenance identity mismatch")
	}
	if _, e = time.Parse(time.RFC3339Nano, m.CreatedAt); e != nil {
		return b, m, errors.New("invalid backup time")
	}
	if len(m.Files) != 6 || len(m.Views) != 3 {
		return b, m, errors.New("incomplete backup")
	}
	for _, name := range []string{"database.dump", "roles.json", ".env", "tls/server.pem", "tls/server.key"} {
		if _, ok := m.Files[name]; !ok {
			return b, m, errors.New("backup missing required material")
		}
	}
	_, key := m.Files["secrets/provider-credential-master.key"]
	_, absent := m.Files["secrets/absent"]
	if key == absent {
		return b, m, errors.New("master key presence must be explicit")
	}
	for name, want := range m.Files {
		limit, ok := backupFiles[name]
		if !ok || name == "backup.json" || want.Size < 0 || want.Size > limit {
			return b, m, errors.New("unknown or oversized backup member")
		}
		have, e := fileHash(filepath.Join(stage, name))
		if e != nil || have != want {
			return b, m, errors.New("backup member checksum/size mismatch")
		}
	}
	for _, p := range []string{"/creation/provider-connection", "/creation/object-storage-connection", "/identity/setup/status"} {
		v, ok := m.Views[p]
		if !ok || (v.Status != 200 && v.Status != 404) || len(v.Digest) != 64 {
			return b, m, errors.New("missing public business-state proof")
		}
	}
	cert, err := os.ReadFile(filepath.Join(stage, "tls/server.pem"))
	if err != nil {
		return b, m, err
	}
	private, err := os.ReadFile(filepath.Join(stage, "tls/server.key"))
	if err != nil {
		return b, m, err
	}
	fingerprint, err := certificateFingerprint(cert, private)
	clear(private)
	if err != nil || fingerprint != m.TLSFingerprint {
		return b, m, errors.New("backup TLS identity mismatch")
	}
	if key && m.Files["secrets/provider-credential-master.key"].Size != 32 {
		return b, m, errors.New("backup master key corrupt")
	}
	return b, m, nil
}
func archiveBackup(out io.Writer, stage string) error {
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)
	names := []string{}
	for name := range backupFiles {
		if _, e := os.Stat(filepath.Join(stage, name)); e == nil {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		f, e := os.Open(filepath.Join(stage, name))
		if e != nil {
			return e
		}
		st, e := f.Stat()
		if e != nil {
			f.Close()
			return e
		}
		if e = tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0600, Size: st.Size()}); e == nil {
			_, e = io.Copy(tw, f)
		}
		f.Close()
		if e != nil {
			return e
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}
func readBackup(path string, r verifiedRuntime) (string, backupMetadata, func(), error) {
	var m backupMetadata
	none := func() {}
	in, err := os.Open(path)
	if err != nil {
		return "", m, none, err
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 {
		return "", m, none, errors.New("backup must be a private regular file (0600)")
	}
	stage, err := os.MkdirTemp("", "nevix-restore-*")
	if err != nil {
		return stage, m, none, err
	}
	cleanup := func() { os.RemoveAll(stage) }
	fail := func(e error) (string, backupMetadata, func(), error) { cleanup(); return "", m, none, e }
	gz, err := gzip.NewReader(in)
	if err != nil {
		return fail(err)
	}
	defer gz.Close()
	tr := tar.NewReader(io.LimitReader(gz, 129<<30))
	seen := map[string]bool{}
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return fail(e)
		}
		limit, ok := backupFiles[h.Name]
		if !ok || seen[h.Name] || h.Typeflag != tar.TypeReg || h.Linkname != "" || h.Size < 0 || h.Size > limit {
			return fail(fmt.Errorf("invalid backup archive entry %q", h.Name))
		}
		seen[h.Name] = true
		target := filepath.Join(stage, h.Name)
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			return fail(e)
		}
		f, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return fail(e)
		}
		_, e = io.Copy(f, tr)
		closeErr := f.Close()
		if e != nil {
			return fail(e)
		}
		if closeErr != nil {
			return fail(closeErr)
		}
	}
	tail, e := io.ReadAll(io.LimitReader(gz, 1025))
	if e != nil || len(tail) > 1024 || len(bytes.Trim(tail, "\x00")) != 0 {
		return fail(errors.New("corrupt backup gzip/footer"))
	}
	_, m, e = validateBackupStage(stage, r)
	if e != nil {
		return fail(e)
	}
	if len(seen) != len(m.Files)+1 {
		return fail(errors.New("backup members disagree with inventory"))
	}
	return stage, m, cleanup, nil
}
func snapshotInstance(directory, current, stage string, r verifiedRuntime) error {
	env, err := privateFile(filepath.Join(directory, ".env"), 1<<20)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(stage, ".env"), env, 0600); err != nil {
		return err
	}
	clear(env)
	out, err := os.OpenFile(filepath.Join(stage, "database.dump"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = runPrivateDocker(composeArgs(directory, current, "nevix", "exec", "-T", "postgres", "pg_dump", "-U", "postgres", "-d", "postgres", "--format=custom"), nil, out)
	closeErr := out.Close()
	if err != nil {
		return errors.New("logical database backup failed before replacement")
	}
	if closeErr != nil {
		return closeErr
	}
	var roles bytes.Buffer
	query := `SELECT json_build_object('postgres',(SELECT rolpassword FROM pg_authid WHERE rolname='postgres'),'identity_app',(SELECT rolpassword FROM pg_authid WHERE rolname='identity_app'));`
	if err = runPrivateDocker(composeArgs(directory, current, "nevix", "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atc", query), nil, &roles); err != nil {
		return errors.New("database role credentials snapshot failed")
	}
	if err = os.WriteFile(filepath.Join(stage, "roles.json"), bytes.TrimSpace(roles.Bytes()), 0600); err != nil {
		clear(roles.Bytes())
		return err
	}
	clear(roles.Bytes())
	if err = copyVolumeSnapshot(r.identities["cert-init"], "nevix_tls", stage, "tls", false); err != nil {
		return err
	}
	return copyVolumeSnapshot(r.identities["cert-init"], "nevix_secrets", stage, "secrets", true)
}
func copyVolumeSnapshot(image, volume, stage, prefix string, optional bool) error {
	// Fixed names and tar regular-file checks keep links/devices out of the backup.
	script := "cd /volume; test -f server.pem && test -f server.key; tar -cf - server.pem server.key"
	if optional {
		script = "cd /volume; if test -e provider-credential-master.key; then test \"$(stat -c %a .)\" = 700; test $(ls -A . | wc -l) -eq 1; test -f provider-credential-master.key && test ! -L provider-credential-master.key && test \"$(stat -c %a provider-credential-master.key)\" = 600; tar -cf - provider-credential-master.key; else test -z \"$(ls -A .)\"; tar -cf - --files-from /dev/null; fi"
	}
	cmd := exec.Command("docker", "run", "--rm", "--pull", "never", "--network", "none", "--mount", "type=volume,source="+volume+",target=/volume,readonly", "--entrypoint", "sh", image, "-ec", script)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	tr := tar.NewReader(stdout)
	count := 0
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			cmd.Process.Kill()
			cmd.Wait()
			return e
		}
		name := prefix + "/" + h.Name
		limit, ok := backupFiles[name]
		if !ok || name == "secrets/absent" || h.Typeflag != tar.TypeReg || h.Linkname != "" || h.Size > limit || h.Size < 0 {
			cmd.Process.Kill()
			cmd.Wait()
			return errors.New("invalid private volume material")
		}
		target := filepath.Join(stage, name)
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			return e
		}
		f, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		_, e = io.Copy(f, tr)
		f.Close()
		if e != nil {
			return e
		}
		count++
	}
	if err = cmd.Wait(); err != nil {
		return errors.New("private volume snapshot failed (permissions/material may be damaged)")
	}
	if optional && count == 0 {
		if err = os.MkdirAll(filepath.Join(stage, prefix), 0700); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(stage, "secrets/absent"), nil, 0600)
	}
	if (!optional && count != 2) || (optional && count != 1) {
		return errors.New("incomplete private volume snapshot")
	}
	return nil
}
