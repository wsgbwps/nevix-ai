package deployment

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"time"
)

func scratchRuntime(stage string, r verifiedRuntime, project string) (string, error) {
	directory, err := os.MkdirTemp("", "nevix-restore-proof-*")
	if err != nil {
		return "", err
	}
	fail := func(e error) (string, error) { os.RemoveAll(directory); return "", e }
	for _, name := range []string{"nginx/nginx.conf", "postgres/init-identity-app.sh", "compose.yaml"} {
		b, e := os.ReadFile(filepath.Join(r.directory, name))
		if e != nil {
			return fail(e)
		}
		target := filepath.Join(directory, name)
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			return fail(e)
		}
		mode := os.FileMode(0600)
		if name == "postgres/init-identity-app.sh" {
			mode = 0755
		}
		if e = os.WriteFile(target, b, mode); e != nil {
			return fail(e)
		}
	}
	env, err := os.ReadFile(filepath.Join(stage, ".env"))
	if err != nil {
		return fail(err)
	}
	if err = os.WriteFile(filepath.Join(directory, ".env"), env, 0600); err != nil {
		return fail(err)
	}
	clear(env)
	b, err := os.ReadFile(filepath.Join(directory, "compose.yaml"))
	if err != nil {
		return fail(err)
	}
	text := strings.ReplaceAll(string(b), `"443:443"`, `"127.0.0.1::443"`)
	for _, suffix := range []string{"pgdata", "tls", "secrets"} {
		text = strings.ReplaceAll(text, "name: nevix_"+suffix, "name: "+project+"_"+suffix)
	}
	text = strings.ReplaceAll(text, "driver: bridge", "driver: bridge\n    internal: true")
	if err = os.WriteFile(filepath.Join(directory, "compose.yaml"), []byte(text), 0600); err != nil {
		return fail(err)
	}
	return directory, nil
}
func rehearseBackup(stage string, m backupMetadata, r verifiedRuntime, c *maintenanceClient, credentials []byte) (retErr error) {
	id, err := operationID()
	if err != nil {
		return err
	}
	project := "nevix-proof-" + strings.ReplaceAll(id, "-", "")
	directory, err := scratchRuntime(stage, r, project)
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	if err = checkBackupConfig(directory, directory); err != nil {
		return err
	}
	// Only this fresh proof's resources may be destroyed; no customer volume cleanup.
	defer func() {
		if _, e := invokeCompose(directory, directory, project, "down", "--volumes", "--remove-orphans"); e != nil {
			retErr = errors.Join(retErr, errors.New("isolated restore proof cleanup failed; inspect project "+project))
		}
	}()
	if _, err = invokeCompose(directory, directory, project, "up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120", "postgres"); err != nil {
		return errors.New("isolated PostgreSQL startup failed")
	}
	if err = restoreDatabase(directory, directory, project, stage); err != nil {
		return err
	}
	if err = restorePrivateVolumes(stage, r, project); err != nil {
		return err
	}
	if err = verifyRestoredCredentials(directory, directory, project, stage); err != nil {
		return err
	}
	if _, err = invokeCompose(directory, directory, project, "up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180"); err != nil {
		return errors.New("isolated restored Server/TLS startup failed")
	}
	port, err := invokeCompose(directory, directory, project, "port", "nginx", "443")
	if err != nil {
		return err
	}
	address := strings.TrimSpace(string(port))
	if _, _, err = net.SplitHostPort(address); err != nil {
		return errors.New("isolated proof has no loopback HTTPS port")
	}
	proof := *c
	transport := c.client.Transport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, address)
	}
	proof.client = &http.Client{Transport: transport, Timeout: c.client.Timeout, CheckRedirect: c.client.CheckRedirect}
	defer proof.client.CloseIdleConnections()
	if len(credentials) > 0 {
		if err = proof.authenticate(credentials); err != nil {
			return err
		}
	}
	return verifyRestoredPublicState(&proof, m, r)
}
func restoreDatabase(directory, current, project, stage string) error {
	for _, args := range [][]string{{"exec", "-T", "postgres", "dropdb", "-U", "postgres", "--maintenance-db=template1", "--force", "--if-exists", "postgres"}, {"exec", "-T", "postgres", "createdb", "-U", "postgres", "--maintenance-db=template1", "--template=template0", "postgres"}} {
		if err := runPrivateDocker(composeArgs(directory, current, project, args...), nil, io.Discard); err != nil {
			return errors.New("database replacement failed; Server must remain stopped")
		}
	}
	f, err := os.Open(filepath.Join(stage, "database.dump"))
	if err != nil {
		return err
	}
	defer f.Close()
	if err = runPrivateDocker(composeArgs(directory, current, project, "exec", "-T", "postgres", "pg_restore", "-U", "postgres", "--dbname=postgres", "--exit-on-error", "--single-transaction"), f, io.Discard); err != nil {
		return errors.New("logical database restore failed; Server must remain stopped")
	}
	return restoreDatabaseRoles(directory, current, project, stage)
}
func restorePrivateVolumes(stage string, r verifiedRuntime, project string) error {
	uid, err := docker("run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "id", r.identities["server"], "-u")
	if err != nil {
		return err
	}
	gid, err := docker("run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "id", r.identities["server"], "-g")
	if err != nil {
		return err
	}
	owner := strings.TrimSpace(string(uid)) + ":" + strings.TrimSpace(string(gid))
	if !regexp.MustCompile(`^\d+:\d+$`).MatchString(owner) {
		return errors.New("invalid Server volume owner")
	}
	for _, prefix := range []string{"tls", "secrets"} {
		var b bytes.Buffer
		tw := tar.NewWriter(&b)
		for _, name := range []string{"tls/server.pem", "tls/server.key", "secrets/provider-credential-master.key"} {
			if !strings.HasPrefix(name, prefix+"/") {
				continue
			}
			data, e := os.ReadFile(filepath.Join(stage, name))
			if os.IsNotExist(e) {
				continue
			}
			if e != nil {
				return e
			}
			if e = tw.WriteHeader(&tar.Header{Name: filepath.Base(name), Typeflag: tar.TypeReg, Mode: 0600, Size: int64(len(data))}); e != nil {
				return e
			}
			if _, e = tw.Write(data); e != nil {
				return e
			}
			clear(data)
		}
		if err = tw.Close(); err != nil {
			return err
		}
		script := "mkdir -p /volume; chmod 700 /volume; rm -f /volume/server.pem /volume/server.key; tar -xf - -C /volume; chmod 600 /volume/server.pem /volume/server.key; chown -R 0:0 /volume"
		if prefix == "secrets" {
			script = "mkdir -p /volume; chmod 700 /volume; rm -f /volume/provider-credential-master.key; tar -xf - -C /volume; if test -e /volume/provider-credential-master.key; then chmod 600 /volume/provider-credential-master.key; fi; chown -R " + owner + " /volume"
		}
		err = runPrivateDocker([]string{"run", "--rm", "--interactive", "--pull", "never", "--network", "none", "--mount", "type=volume,source=" + project + "_" + prefix + ",target=/volume", "--entrypoint", "sh", r.identities["cert-init"], "-ec", script}, &b, io.Discard)
		clear(b.Bytes())
		if err != nil {
			return errors.New("private key/TLS restore failed; Server must remain stopped")
		}
	}
	return nil
}

// Restore validation follows ADR-0016's fixed envelope contract without invoking providers or importing Creation internals.
func verifyRestoredCredentials(directory, current, project, stage string) error {
	query := `SELECT json_build_object('kind','provider','id',id,'provider','kapon','version',envelope_version,'key_id',credential_key_id,'nonce',encode(credential_nonce,'hex'),'ciphertext',encode(credential_ciphertext,'hex')) FROM public.provider_connections WHERE credential_ciphertext IS NOT NULL UNION ALL SELECT json_build_object('kind','storage','id',id,'provider',provider,'version',envelope_version,'key_id',credential_key_id,'nonce',encode(credential_nonce,'hex'),'ciphertext',encode(credential_ciphertext,'hex')) FROM public.object_storage_connections WHERE credential_ciphertext IS NOT NULL;`
	var out bytes.Buffer
	if err := runPrivateDocker(composeArgs(directory, current, project, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atc", query), nil, &out); err != nil {
		return errors.New("restored credential inventory unavailable")
	}
	defer clear(out.Bytes())
	rows := bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n"))
	if len(rows) == 1 && len(rows[0]) == 0 {
		return nil
	}
	key, err := os.ReadFile(filepath.Join(stage, "secrets/provider-credential-master.key"))
	if err != nil || len(key) != 32 {
		return errors.New("encrypted credentials exist but backup master key is missing/corrupt")
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(key)
	keyID := hex.EncodeToString(sum[:8])
	for _, row := range rows {
		var e struct {
			Kind, ID, Provider, KeyID, Nonce, Ciphertext string
			Version                                      int
		}
		var raw struct {
			Kind       string `json:"kind"`
			ID         string `json:"id"`
			Provider   string `json:"provider"`
			Version    int    `json:"version"`
			KeyID      string `json:"key_id"`
			Nonce      string `json:"nonce"`
			Ciphertext string `json:"ciphertext"`
		}
		if json.Unmarshal(row, &raw) != nil {
			return errors.New("invalid restored credential envelope")
		}
		e.Kind, e.ID, e.Provider, e.Version, e.KeyID, e.Nonce, e.Ciphertext = raw.Kind, raw.ID, raw.Provider, raw.Version, raw.KeyID, raw.Nonce, raw.Ciphertext
		if e.Version != 1 || e.KeyID != keyID {
			return errors.New("restored credential key identity/version mismatch")
		}
		nonce, err := hex.DecodeString(e.Nonce)
		if err != nil || len(nonce) != aead.NonceSize() {
			return errors.New("restored credential nonce invalid")
		}
		ciphertext, err := hex.DecodeString(e.Ciphertext)
		if err != nil {
			return errors.New("restored credential ciphertext invalid")
		}
		aad := "nevix.creation.provider_credential.v1|" + e.ID + "|kapon|provider_key"
		if e.Kind == "storage" {
			aad = "nevix.creation.object_storage_credential.v1|" + e.ID + "|" + e.Provider + "|access_key_pair"
		} else if e.Kind != "provider" {
			return errors.New("unknown restored credential purpose")
		}
		plaintext, err := aead.Open(nil, nonce, ciphertext, []byte(aad))
		clear(plaintext)
		if err != nil {
			return errors.New("restored credentials cannot decrypt with backup master key")
		}
	}
	return nil
}
func verifyRunningRelease(c *maintenanceClient, r verifiedRuntime) error {
	return waitRunningRelease(c, r, 0)
}
func waitRunningRelease(c *maintenanceClient, r verifiedRuntime, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	// Container restart acknowledges process creation, not HTTPS listener readiness.
	// Retry only bounded read-only reachability/edge-unavailable outcomes, never maintenance mutations.
	for {
		c.client.CloseIdleConnections()
		b, status, err := c.request("GET", "/release/version", nil)
		if err != nil || status != 200 {
			if timeout > 0 && (status == 0 || status == 502 || status == 503) && time.Now().Before(deadline) {
				time.Sleep(100 * time.Millisecond)
				continue
			}
			return fmt.Errorf("running Server HTTPS version unavailable (HTTP %d): %w", status, err)
		}
		var v struct {
			Service    string `json:"service"`
			Version    string `json:"version"`
			MinDesktop string `json:"min_desktop_version"`
		}
		if json.Unmarshal(b, &v) != nil || v.Service != "nevix-server" || v.Version != r.manifest.Version || v.MinDesktop != r.manifest.MinDesktopVersion {
			return errors.New("running version differs from verified release")
		}
		return nil
	}
}
func verifyRestoredPublicState(c *maintenanceClient, m backupMetadata, r verifiedRuntime) error {
	if err := verifyRunningRelease(c, r); err != nil {
		return err
	}
	s, err := c.snapshot()
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(s, m.Maintenance) {
		return errors.New("restored public Admin maintenance/task state differs from backup")
	}
	views, err := captureViews(c)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(views, m.Views) {
		return errors.New("restored public business configuration differs from backup")
	}
	return nil
}
func restoreBackup(o backupOptions, r verifiedRuntime, stage string, m backupMetadata) (retErr error) {
	if o.client.pin != m.TLSFingerprint {
		return errors.New("confirmed customer TLS pin differs from backup identity")
	}
	// Recreate only the verified release/config; never execute a customer's backup archive.
	current := filepath.Join(o.directory, "releases", m.Version)
	if err := os.MkdirAll(current, 0700); err != nil {
		return err
	}
	for name := range bundleFiles {
		if name == "images.tar" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(r.directory, name))
		if err != nil {
			return err
		}
		target := filepath.Join(current, name)
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		mode := os.FileMode(0600)
		if name == "tools/nevix-deploy" {
			mode = 0700
		}
		if name == "postgres/init-identity-app.sh" {
			mode = 0755
		}
		if err = os.WriteFile(target, data, mode); err != nil {
			return err
		}
	}
	compose, err := os.ReadFile(filepath.Join(r.directory, "compose.yaml"))
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(current, "compose.yaml"), compose, 0600); err != nil {
		return err
	}
	old := current
	if _, err := os.Stat(filepath.Join(o.directory, ".env")); os.IsNotExist(err) {
		b, e := os.ReadFile(filepath.Join(stage, ".env"))
		if e != nil {
			return e
		}
		if e = replacePrivateFile(o.directory, ".env", b); e != nil {
			return e
		}
		clear(b)
	}
	if _, err = invokeCompose(o.directory, old, "nevix", "stop", "--timeout", "60", "server", "nginx", "cert-watch"); err != nil {
		return errors.New("restore did not safely stop current Server/edge; data untouched")
	}
	if err = assertServerStopped(o.directory, old); err != nil {
		return err
	}
	// Every failure after the stop leaves the instance closed; no automatic destructive recovery.
	defer func() {
		if retErr != nil {
			_, e := invokeCompose(o.directory, current, "nevix", "stop", "server", "nginx")
			retErr = errors.Join(retErr, fmt.Errorf("restore incomplete; keep instance stopped, retain backup and retry explicit restore (stop result: %v)", e))
		}
	}()
	env, err := os.ReadFile(filepath.Join(stage, ".env"))
	if err != nil {
		return err
	}
	if err = replacePrivateFile(o.directory, ".env", env); err != nil {
		return err
	}
	clear(env)
	if _, err = invokeCompose(o.directory, current, "nevix", "up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120", "postgres"); err != nil {
		return errors.New("restore PostgreSQL startup failed")
	}
	if err = restoreDatabase(o.directory, old, "nevix", stage); err != nil {
		return err
	}
	if err = restorePrivateVolumes(stage, r, "nevix"); err != nil {
		return err
	}
	if err = verifyRestoredCredentials(o.directory, old, "nevix", stage); err != nil {
		return err
	}
	if _, err = invokeCompose(o.directory, current, "nevix", "up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180"); err != nil {
		return errors.New("restored Server startup failed; database was restored, switching images is not a rollback")
	}
	if _, err = invokeCompose(o.directory, current, "nevix", "restart", "nginx"); err != nil {
		return err
	}
	if err = waitRunningRelease(o.client, r, 20*time.Second); err != nil {
		return err
	}
	if err = o.client.authenticate(o.credentials); err != nil {
		return err
	}
	if err = verifyRestoredPublicState(o.client, m, r); err != nil {
		return err
	}
	if err = replacePrivateFile(o.directory, "current", []byte(m.Version+"\n")); err != nil {
		return err
	}
	if err = o.client.resume(m.Maintenance); err != nil {
		return errors.New("restored instance remains paused; original Admin session/maintenance resume must succeed")
	}
	if j, e := readUpgradeJournal(o.directory); e == nil && j.OriginalVersion == m.Version {
		backupPath, _ := filepath.Abs(o.backup)
		if backupPath == j.Backup {
			if e = os.Remove(filepath.Join(o.directory, "upgrade.json")); e != nil {
				return e
			}
		}
	}
	fmt.Println("restored verified complete Nevix", m.Version, "instance; post-backup writes were discarded; OSS objects were untouched")
	return nil
}

func restoreDatabaseRoles(directory, current, project, stage string) error {
	b, err := os.ReadFile(filepath.Join(stage, "roles.json"))
	if err != nil {
		return err
	}
	defer clear(b)
	var roles map[string]string
	if json.Unmarshal(b, &roles) != nil || len(roles) != 2 {
		return errors.New("invalid backed-up database role credentials")
	}
	var script strings.Builder
	pattern := regexp.MustCompile(`^(SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+|md5[a-f0-9]{32})$`)
	for _, name := range []string{"postgres", "identity_app"} {
		password, ok := roles[name]
		if !ok || !pattern.MatchString(password) {
			return errors.New("invalid backed-up PostgreSQL password verifier")
		}
		script.WriteString("ALTER ROLE " + name + " PASSWORD '" + password + "';\n")
	}
	if err = runPrivateDocker(composeArgs(directory, current, project, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"), strings.NewReader(script.String()), io.Discard); err != nil {
		return errors.New("database role credential restore failed")
	}
	return nil
}
