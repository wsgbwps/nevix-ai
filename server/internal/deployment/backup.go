package deployment

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/nevix-ai/server/internal/release"
)

const restoreConfirmation = "RESTORE-LOSE-POST-BACKUP-WRITES"

type backupOptions struct {
	command, directory, bundle, manifest, backup, output, confirm string
	client                                                        *maintenanceClient
	timeout                                                       time.Duration
	credentials                                                   []byte
}
type verifiedRuntime struct {
	directory  string
	manifest   release.Manifest
	inventory  inventory
	identities map[string]string
	envelope   []byte
}

func backupCommand(args []string, key string) error {
	o := backupOptions{command: args[0]}
	f := flag.NewFlagSet(args[0], flag.ContinueOnError)
	f.StringVar(&o.directory, "directory", "", "instance directory")
	f.StringVar(&o.bundle, "bundle", "", "original signed release tar.gz")
	f.StringVar(&o.manifest, "manifest", "", "original signed release envelope")
	f.StringVar(&o.backup, "backup", "", "private instance backup tar.gz")
	f.StringVar(&o.output, "output", "", "new backup archive (must not exist)")
	f.StringVar(&o.confirm, "confirm", "", "explicit restore data-loss confirmation")
	base := f.String("server-url", "", "customer HTTPS origin")
	pin := f.String("tls-fingerprint", "", "independently verified customer certificate SHA-256")
	token := f.String("token-file", "", "private Admin session file")
	credentials := f.String("credentials-file", "", "private backup-era Admin email/password JSON for recovery")
	f.DurationVar(&o.timeout, "drain-timeout", 30*time.Minute, "task drain deadline")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if o.command == "restore" && o.confirm != restoreConfirmation {
		return errors.New("restore discards post-backup writes; explicitly supply --confirm " + restoreConfirmation)
	}
	if f.NArg() != 0 || o.directory == "" || o.bundle == "" || o.manifest == "" || (o.command == "backup" && o.output == "") || (o.command != "backup" && o.backup == "") || o.timeout <= 0 {
		return errors.New("directory, original bundle/manifest, private Admin session, TLS pin and backup/output required")
	}
	if o.command == "restore" {
		if err := os.MkdirAll(o.directory, 0700); err != nil {
			return err
		}
		if err := validatePrivateDestination(o.directory, ".env"); err != nil {
			return err
		}
	}
	c, err := newMaintenanceClient(*base, *pin, *token)
	if err != nil {
		return err
	}
	if o.command != "backup" {
		o.credentials, err = privateFile(*credentials, 16<<10)
		if err != nil {
			return err
		}
		defer clear(o.credentials)
	}
	o.client = c
	defer c.client.CloseIdleConnections()
	runtime, cleanup, err := verifiedBackupRuntime(o.bundle, o.manifest, key)
	if err != nil {
		return err
	}
	defer cleanup()
	if err = checkDocker(); err != nil {
		return err
	}
	if o.command == "backup" {
		if err = privateConfig(o.directory); err != nil {
			return err
		}
	} else if err = os.MkdirAll(o.directory, 0700); err != nil {
		return err
	}
	lock, err := lockInstance(o.directory)
	if err != nil {
		return err
	}
	defer func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() }()
	if o.command == "backup" {
		return createBackup(o, runtime)
	}
	stage, meta, cleanup, err := readBackup(o.backup, runtime)
	if err != nil {
		return err
	}
	defer cleanup()
	if err = rehearseBackup(stage, meta, runtime, c, o.credentials); err != nil {
		return fmt.Errorf("isolated backup restore verification failed: %w", err)
	}
	if o.command == "verify-backup" {
		fmt.Println("verified complete isolated restore of Nevix", meta.Version)
		return nil
	}
	return restoreBackup(o, runtime, stage, meta)
}
func lockInstance(directory string) (*os.File, error) {
	if err := privateInstanceDirectory(directory); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(directory, ".operation.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another Nevix instance operation is running")
	}
	return f, nil
}
func verifiedBackupRuntime(bundle, manifest, key string) (verifiedRuntime, func(), error) {
	r, cleanup, err := verifiedRuntimeArchive(bundle, manifest, key)
	if err != nil {
		return r, cleanup, err
	}
	r.identities, err = inspectImages(r.inventory)
	if err == nil {
		var compose []byte
		compose, err = renderCompose(r.directory, r.identities)
		if err == nil {
			err = os.WriteFile(filepath.Join(r.directory, "compose.yaml"), compose, 0600)
		}
	}
	if err != nil {
		cleanup()
		return r, func() {}, err
	}
	return r, cleanup, nil
}
func verifiedRuntimeArchive(bundle, manifest, key string) (verifiedRuntime, func(), error) {
	var r verifiedRuntime
	cleanup := func() {}
	f, err := os.Open(manifest)
	if err != nil {
		return r, cleanup, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 64<<10+1))
	if err != nil {
		return r, cleanup, err
	}
	if len(b) > 64<<10 {
		return r, cleanup, errors.New("release manifest too large")
	}
	r.envelope = b
	r.manifest, err = release.Verify(b, key, "linux", "amd64")
	if err != nil {
		return r, cleanup, fmt.Errorf("verify signed release: %w", err)
	}
	spool, err := authenticatedSpool(bundle, r.manifest)
	if err != nil {
		return r, cleanup, err
	}
	defer func() { spool.Close(); os.Remove(spool.Name()) }()
	r.directory, err = os.MkdirTemp("", "nevix-backup-runtime-*")
	if err != nil {
		return r, cleanup, err
	}
	cleanup = func() { os.RemoveAll(r.directory) }
	fail := func(e error) (verifiedRuntime, func(), error) { cleanup(); return r, func() {}, e }
	if err = extractClosedBundle(spool, r.directory); err != nil {
		return fail(err)
	}
	r.inventory, err = readInventory(r.directory, r.manifest)
	if err != nil {
		return fail(err)
	}
	if err = validateImageArchive(filepath.Join(r.directory, "images.tar"), r.inventory); err != nil {
		return fail(err)
	}
	return r, cleanup, nil
}
func composeArgs(directory, releaseDir, project string, args ...string) []string {
	prefix := []string{"compose", "--project-name", project, "--env-file", filepath.Join(directory, ".env"), "-f", filepath.Join(releaseDir, "compose.yaml")}
	return append(prefix, args...)
}
func invokeCompose(directory, releaseDir, project string, args ...string) ([]byte, error) {
	return docker(composeArgs(directory, releaseDir, project, args...)...)
}
func runPrivateDocker(args []string, in io.Reader, out io.Writer) error {
	cmd := exec.Command("docker", args...)
	cmd.Stdin = in
	cmd.Stdout = out
	// Container tooling may echo private data on stderr; never surface its raw output.
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("Docker %s failed; private command output withheld", args[0])
	}
	return nil
}
func validateCurrentRuntime(o backupOptions, r verifiedRuntime) (string, error) {
	b, err := os.ReadFile(filepath.Join(o.directory, "current"))
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(string(b)) != r.manifest.Version {
		return "", errors.New("original release bundle must match installed current version")
	}
	current := filepath.Join(o.directory, "releases", r.manifest.Version)
	want, err := os.ReadFile(filepath.Join(r.directory, "compose.yaml"))
	if err != nil {
		return "", err
	}
	have, err := os.ReadFile(filepath.Join(current, "compose.yaml"))
	if err != nil || !bytes.Equal(want, have) {
		return "", errors.New("installed runtime Compose differs from verified release")
	}
	for _, name := range []string{"nginx/nginx.conf", "postgres/init-identity-app.sh"} {
		want, err = os.ReadFile(filepath.Join(r.directory, name))
		if err != nil {
			return "", err
		}
		have, err = os.ReadFile(filepath.Join(current, name))
		if err != nil || !bytes.Equal(want, have) {
			return "", errors.New("installed runtime config differs from verified release")
		}
	}
	if err = checkBackupConfig(o.directory, current); err != nil {
		return "", err
	}
	return current, nil
}
func createBackup(o backupOptions, r verifiedRuntime) (retErr error) {
	current, err := validateCurrentRuntime(o, r)
	if err != nil {
		return err
	}
	if err = verifyRunningRelease(o.client, r); err != nil {
		return err
	}
	out, err := os.OpenFile(o.output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer out.Close()
	accepted := false
	defer func() {
		if !accepted {
			os.Remove(o.output)
		}
	}()
	pause, err := o.client.pauseAndDrain(o.timeout)
	if pause.Paused && pause.Owner != nil {
		stopped := false
		defer func() {
			if stopped {
				_, e := invokeCompose(o.directory, current, "nevix", "up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "server")
				if e != nil {
					retErr = errors.Join(retErr, errors.New("old Server could not restart; maintenance remains paused"))
					return
				}
				if _, e = invokeCompose(o.directory, current, "nevix", "restart", "nginx"); e != nil {
					retErr = errors.Join(retErr, errors.New("old edge could not restart; maintenance remains paused"))
					return
				}
			}
			if e := o.client.resume(pause); e != nil {
				retErr = errors.Join(retErr, errors.New("owned maintenance could not resume; instance remains paused; retry this operation's owner/revision explicitly"))
			}
		}()
		if err != nil {
			return err
		}
		stage, e := os.MkdirTemp("", "nevix-instance-backup-*")
		if e != nil {
			return e
		}
		defer os.RemoveAll(stage)
		views, e := captureViews(o.client)
		if e != nil {
			return e
		}
		stopped = true // stop may have succeeded even if the response was lost.
		if _, e = invokeCompose(o.directory, current, "nevix", "stop", "--timeout", "60", "server"); e != nil {
			return errors.New("Server stop failed; no snapshot taken")
		}
		if e = assertServerStopped(o.directory, current); e != nil {
			return e
		}
		meta := backupMetadata{Format: "nevix-instance-backup-v1", Version: r.manifest.Version, ReleaseSHA512: r.manifest.SHA512, PostgresMajor: r.inventory.PostgresMajor, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Maintenance: pause, Views: views, TLSFingerprint: o.client.pin}
		if e = snapshotInstance(o.directory, current, stage, r); e != nil {
			return e
		}
		if e = writeBackupMetadata(stage, meta); e != nil {
			return e
		}
		_, checked, e := validateBackupStage(stage, r)
		if e != nil {
			return e
		}
		if e = rehearseBackup(stage, checked, r, o.client, nil); e != nil {
			return fmt.Errorf("backup is not proven recoverable: %w", e)
		}
		if e = archiveBackup(out, stage); e != nil {
			return e
		}
		if e = out.Sync(); e != nil {
			return e
		}
		accepted = true
		fmt.Println("backed up and verified complete Nevix", r.manifest.Version, "instance at", o.output)
		return nil
	}
	return err
}
func assertServerStopped(directory, current string) error {
	b, err := invokeCompose(directory, current, "nevix", "ps", "--status", "running", "--quiet", "server")
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(b)) != 0 {
		return errors.New("Server still running; consistent snapshot refused")
	}
	return nil
}

type publicView struct {
	Status int    `json:"status"`
	Digest string `json:"sha256"`
}

func captureViews(c *maintenanceClient) (map[string]publicView, error) {
	result := map[string]publicView{}
	for _, path := range []string{"/creation/provider-connection", "/creation/object-storage-connection", "/identity/setup/status"} {
		b, status, err := c.request("GET", path, nil)
		if err != nil {
			return nil, err
		}
		var value any
		if json.Unmarshal(b, &value) != nil {
			return nil, errors.New("invalid public business-state response")
		}
		canonical, _ := json.Marshal(value)
		result[path] = publicView{status, hashBytes(canonical)}
	}
	return result, nil
}

func checkBackupConfig(directory, current string) error {
	var out bytes.Buffer
	if err := runPrivateDocker(composeArgs(directory, current, "nevix", "config", "--format", "json"), nil, &out); err != nil {
		return errors.New("customer Compose configuration invalid")
	}
	defer clear(out.Bytes())
	var resolved struct {
		Services map[string]struct {
			Environment map[string]string `json:"environment"`
		} `json:"services"`
	}
	if json.Unmarshal(out.Bytes(), &resolved) != nil || resolved.Services["cert-init"].Environment["CERT_FORCE_NEW"] != "false" {
		return errors.New("clear CERT_FORCE_NEW before backup/restore; TLS identity must not rotate")
	}
	return nil
}
