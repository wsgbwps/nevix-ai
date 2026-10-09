package deployment

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"time"

	"github.com/nevix-ai/server/internal/release"
)

type upgradeJournal struct {
	Format           string `json:"format"`
	OriginalVersion  string `json:"original_version"`
	CandidateVersion string `json:"candidate_version"`
	Backup           string `json:"backup"`
	Phase            string `json:"phase"`
	Owner            string `json:"owner_token"`
	Revision         int64  `json:"expected_revision"`
}

func writeUpgradeJournal(directory string, j upgradeJournal) error {
	b, err := json.Marshal(j)
	if err != nil {
		return err
	}
	return replacePrivateFile(directory, "upgrade.json", b)
}
func upgradeCommand(args []string, key string) (retErr error) {
	o := backupOptions{command: args[0]}
	f := flag.NewFlagSet(o.command, flag.ContinueOnError)
	f.StringVar(&o.directory, "directory", "", "existing instance directory")
	f.StringVar(&o.bundle, "original-bundle", "", "original signed release archive")
	f.StringVar(&o.manifest, "original-manifest", "", "original signed release envelope")
	f.StringVar(&o.output, "backup", "", "new private recoverable backup (must not exist)")
	candidateBundle := f.String("bundle", "", "candidate signed release archive")
	candidateManifest := f.String("manifest", "", "candidate signed release envelope")
	base := f.String("server-url", "", "customer HTTPS origin")
	pin := f.String("tls-fingerprint", "", "independently verified customer certificate SHA-256")
	token := f.String("token-file", "", "private current Admin session file")
	f.DurationVar(&o.timeout, "drain-timeout", 30*time.Minute, "task drain deadline")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 || o.directory == "" || o.bundle == "" || o.manifest == "" || (o.command == "upgrade" && (o.output == "" || *candidateBundle == "" || *candidateManifest == "")) || *token == "" || o.timeout <= 0 {
		return errors.New("existing directory, original and candidate bundle/manifest, new backup, private Admin token and customer TLS pin required")
	}
	if o.command == "upgrade" {
		if err := outsideInstanceBackup(o.directory, o.output); err != nil {
			return err
		}
	}
	c, err := newMaintenanceClient(*base, *pin, *token)
	if err != nil {
		return err
	}
	o.client = c
	defer c.client.CloseIdleConnections()
	if o.command == "recover-upgrade" {
		return recoverUpgrade(o, key, *candidateBundle, *candidateManifest)
	}
	candidate, cleanup, err := verifiedRuntimeArchive(*candidateBundle, *candidateManifest, key)
	if err != nil {
		return err
	}
	defer cleanup()
	original, cleanupOriginal, err := verifiedBackupRuntime(o.bundle, o.manifest, key)
	if err != nil {
		return err
	}
	defer cleanupOriginal()
	cmp, err := release.CompareVersions(candidate.manifest.Version, original.manifest.Version)
	if err != nil || cmp <= 0 {
		return errors.New("upgrade candidate must be newer than original release")
	}
	cmp, err = release.CompareVersions(original.manifest.Version, candidate.manifest.MinServerVersion)
	if err != nil || cmp < 0 {
		return errors.New("candidate requires a newer source Server; upgrade through a compatible intermediate release")
	}
	if candidate.inventory.PostgresMajor != original.inventory.PostgresMajor {
		return errors.New("PostgreSQL major upgrades are not supported")
	}
	if err = checkDocker(); err != nil {
		return err
	}
	if err = privateConfig(o.directory); err != nil {
		return err
	}
	lock, err := lockInstance(o.directory)
	if err != nil {
		return err
	}
	defer func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() }()
	current, err := validateCurrentRuntime(o, original)
	if err != nil {
		return err
	}
	if _, err = os.Lstat(filepath.Join(o.directory, "upgrade.json")); err == nil {
		return errors.New("unfinished upgrade journal exists; follow scripts/instance-upgrade.md recovery using the retained original bundle and backup; no automatic replacement or database rollback")
	} else if !os.IsNotExist(err) {
		return err
	}
	if err = verifyRunningRelease(c, original); err != nil {
		return err
	}
	// Import only the already authenticated archive and envelope; mutable input paths are not reread.
	if err = importRuntime("import", candidate.directory, o.directory, candidate.envelope, candidate.manifest, candidate.inventory); err != nil {
		return err
	}
	candidate.directory = filepath.Join(o.directory, "releases", candidate.manifest.Version)
	candidate.identities, err = inspectImages(candidate.inventory)
	if err != nil {
		return err
	}
	if err = validateUpgradeCompose(o.directory, current, candidate.directory); err != nil {
		return err
	}
	backupPath, err := filepath.Abs(o.output)
	if err != nil {
		return err
	}
	if err = privateInstanceDirectory(filepath.Dir(backupPath)); err != nil {
		return err
	}
	out, err := os.OpenFile(o.output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
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
	j := upgradeJournal{Format: "nevix-upgrade-v1", OriginalVersion: original.manifest.Version, CandidateVersion: candidate.manifest.Version, Backup: backupPath, Phase: "pause-intent"}
	journalWritten := false
	pause, err := c.pauseAndDrainJournal(o.timeout, func(owner string, revision int64) error {
		j.Owner = owner
		j.Revision = revision
		e := writeUpgradeJournal(o.directory, j)
		journalWritten = e == nil
		return e
	})
	stopped, replacing := false, false
	// Before replacement, failure recovers only this operation's own pause. Once replacement
	// may have started, image rollback cannot undo migrations: keep the instance closed.
	defer func() {
		if retErr == nil {
			return
		}
		if replacing {
			_, e := invokeCompose(o.directory, candidate.directory, "nevix", "stop", "server", "nginx")
			retErr = errors.Join(retErr, fmt.Errorf("replacement failed; maintenance ownership retained and Server/edge stopped (stop result: %v); retained backup %s; explicitly restore original release with --confirm %s", e, backupPath, restoreConfirmation))
			return
		}
		if journalWritten && (!pause.Paused || pause.Owner == nil) {
			observed, e := c.snapshot()
			if e != nil || observed.Paused || observed.Revision != j.Revision {
				retErr = errors.Join(retErr, errors.New("pause outcome uncertain; intent journal retained; run recover-upgrade before replacement"))
				return
			}
		}
		if pause.Paused && pause.Owner != nil {
			if stopped {
				if _, e := invokeCompose(o.directory, current, "nevix", "up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "server"); e != nil {
					retErr = errors.Join(retErr, errors.New("old Server restart failed; maintenance retained"))
					return
				}
				if _, e := invokeCompose(o.directory, current, "nevix", "restart", "nginx"); e != nil {
					retErr = errors.Join(retErr, e)
					return
				}
				if e := waitRunningRelease(c, original, 20*time.Second); e != nil {
					retErr = errors.Join(retErr, e)
					return
				}
			}
			if e := c.resume(pause); e != nil {
				retErr = errors.Join(retErr, errors.New("owned maintenance resume failed; journal retained"))
				return
			}
		}
		if e := os.Remove(filepath.Join(o.directory, "upgrade.json")); e != nil && !os.IsNotExist(e) {
			retErr = errors.Join(retErr, e)
		}
	}()
	if err != nil {
		return err
	}
	j.Phase = "paused"
	j.Revision = pause.Revision
	if err = writeUpgradeJournal(o.directory, j); err != nil {
		return err
	}
	views, err := captureViews(c)
	if err != nil {
		return err
	}
	stage, err := os.MkdirTemp("", "nevix-upgrade-backup-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	stopped = true
	if _, err = invokeCompose(o.directory, current, "nevix", "stop", "--timeout", "60", "server"); err != nil {
		return errors.New("Server stop failed; no snapshot taken")
	}
	if err = assertServerStopped(o.directory, current); err != nil {
		return err
	}
	meta := backupMetadata{Format: "nevix-instance-backup-v1", Version: original.manifest.Version, ReleaseSHA512: original.manifest.SHA512, PostgresMajor: original.inventory.PostgresMajor, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Maintenance: pause, Views: views, TLSFingerprint: c.pin}
	if err = snapshotInstance(o.directory, current, stage, original); err != nil {
		return err
	}
	if err = writeBackupMetadata(stage, meta); err != nil {
		return err
	}
	_, meta, err = validateBackupStage(stage, original)
	if err != nil {
		return err
	}
	var baseline snapshotViews
	if err = rehearseBackupSnapshot(stage, meta, original, c, nil, &baseline); err != nil {
		return fmt.Errorf("backup is not proven recoverable: %w", err)
	}
	meta.Views = baseline.Configuration
	if err = writeBackupMetadata(stage, meta); err != nil {
		return err
	}
	if _, meta, err = validateBackupStage(stage, original); err != nil {
		return err
	}
	if err = archiveBackup(out, stage); err != nil {
		return err
	}
	if err = finishBackupArchive(out); err != nil {
		return err
	}
	accepted = true
	j.Phase = "replacing"
	if err = writeUpgradeJournal(o.directory, j); err != nil {
		return err
	}
	replacing = true
	if _, err = invokeCompose(o.directory, current, "nevix", "stop", "nginx"); err != nil {
		return err
	}
	// Dependencies stay on their original running images; do not replace PostgreSQL or rotate TLS.
	if _, err = invokeCompose(o.directory, candidate.directory, "nevix", "up", "--detach", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "server"); err != nil {
		return errors.New("candidate startup/migration/health failed; inspect private Server logs")
	}
	if _, err = invokeCompose(o.directory, candidate.directory, "nevix", "up", "--detach", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "60", "nginx"); err != nil {
		return errors.New("candidate edge startup failed")
	}
	if _, err = invokeCompose(o.directory, candidate.directory, "nevix", "restart", "nginx"); err != nil {
		return err
	}
	if err = waitRunningRelease(c, candidate, 20*time.Second); err != nil {
		return err
	}
	s, err := c.snapshot()
	if err != nil || !reflect.DeepEqual(s, pause) {
		return errors.New("candidate maintenance/drained task state differs from owned backup")
	}
	retainedHistory, err := captureUpgradeHistory(c)
	if err != nil || !reflect.DeepEqual(baseline.History, retainedHistory) {
		return errors.New("candidate public User/Creation history differs from source snapshot")
	}
	retained, err := captureViews(c)
	if err != nil || !reflect.DeepEqual(retained, meta.Views) {
		return errors.New("candidate public business configuration differs from backup")
	}
	env, err := privateFile(filepath.Join(o.directory, ".env"), 1<<20)
	if err != nil {
		return err
	}
	defer clear(env)
	backupEnv, err := os.ReadFile(filepath.Join(stage, ".env"))
	if err != nil {
		return err
	}
	defer clear(backupEnv)
	if !bytes.Equal(env, backupEnv) {
		return errors.New("customer config changed during replacement")
	}
	if err = verifyRestoredCredentials(o.directory, candidate.directory, "nevix", stage); err != nil {
		return err
	}
	if err = verifyUpgradePrivateVolumes(o.directory, candidate.directory, stage, candidate); err != nil {
		return err
	}
	j.Phase = "verified"
	if err = writeUpgradeJournal(o.directory, j); err != nil {
		return err
	}
	if err = replacePrivateFile(o.directory, "current", []byte(candidate.manifest.Version+"\n")); err != nil {
		return err
	}
	j.Phase = "resume-intent"
	if err = writeUpgradeJournal(o.directory, j); err != nil {
		return err
	}
	if err = c.resume(pause); err != nil {
		return errors.New("candidate verified but owned admission resume failed; journal retained")
	}
	j.Phase = "complete"
	if err = writeUpgradeJournal(o.directory, j); err != nil {
		return fmt.Errorf("admission resume completed but journal durability failed; reconcile non-destructively using recover-upgrade: %w", err)
	}
	if err = removeUpgradeJournal(o.directory); err != nil {
		return err
	}
	fmt.Println("upgraded verified Nevix", original.manifest.Version, "to", candidate.manifest.Version, "; recoverable private backup retained at", backupPath)
	return nil
}
func validateUpgradeCompose(directory, old, new string) error {
	// Resolve private configuration without printing credentials. Only Server/Nginx are replaced.
	var results [2]struct {
		Services map[string]struct {
			Image   string `json:"image"`
			Volumes []struct{ Type, Source, Target string }
		}
		Volumes map[string]struct{ Name string }
	}
	for i, path := range []string{old, new} {
		var b bytes.Buffer
		if err := runPrivateDocker(composeArgs(directory, path, "nevix", "config", "--format", "json"), nil, &b); err != nil {
			return err
		}
		if json.Unmarshal(b.Bytes(), &results[i]) != nil {
			clear(b.Bytes())
			return errors.New("invalid runtime config")
		}
		clear(b.Bytes())
	}
	if !reflect.DeepEqual(results[0].Volumes, results[1].Volumes) || len(results[0].Volumes) != 3 || results[1].Volumes["pgdata"].Name != "nevix_pgdata" || results[1].Volumes["tls"].Name != "nevix_tls" || results[1].Volumes["secrets"].Name != "nevix_secrets" {
		return errors.New("upgrade must retain fixed Nevix volume identities")
	}
	for _, service := range []string{"server", "postgres", "cert-init", "cert-watch", "nginx"} {
		// Runtime config paths are versioned; compare logical named volumes, ignoring bind paths.
		named := func(i int) any {
			var v []string
			for _, mount := range results[i].Services[service].Volumes {
				if mount.Type == "volume" {
					v = append(v, mount.Source+":"+mount.Target)
				}
			}
			return v
		}
		if !reflect.DeepEqual(named(0), named(1)) {
			return errors.New("upgrade must retain persistent mounts")
		}
	}
	return nil
}
func verifyUpgradePrivateVolumes(directory, current, stage string, r verifiedRuntime) error {
	// Snapshot just the existing private materials using the same closed inventory rules.
	check, err := os.MkdirTemp("", "nevix-upgrade-private-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(check)
	for _, prefix := range []string{"tls", "secrets"} {
		if err = copyVolumeSnapshot(r.identities["cert-init"], "nevix_"+prefix, check, prefix, prefix == "secrets"); err != nil {
			return err
		}
	}
	for _, name := range []string{"tls/server.pem", "tls/server.key", "secrets/provider-credential-master.key", "secrets/absent"} {
		want, e := os.ReadFile(filepath.Join(stage, name))
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return e
		}
		have, e := os.ReadFile(filepath.Join(check, name))
		same := e == nil && bytes.Equal(want, have)
		clear(want)
		clear(have)
		if !same {
			return errors.New("candidate changed customer TLS/master-key identity")
		}
	}
	return nil
}

func readUpgradeJournal(directory string) (upgradeJournal, error) {
	var j upgradeJournal
	b, err := privateFile(filepath.Join(directory, "upgrade.json"), 16<<10)
	if err != nil {
		return j, err
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if d.Decode(&j) != nil || j.Format != "nevix-upgrade-v1" || j.Owner == "" || j.Revision < 0 || !filepath.IsAbs(j.Backup) {
		return j, errors.New("invalid upgrade journal; preserve it for recovery")
	}
	return j, nil
}
func recoverUpgrade(o backupOptions, key, candidateBundle, candidateManifest string) error {
	r, cleanup, err := verifiedBackupRuntime(o.bundle, o.manifest, key)
	if err != nil {
		return err
	}
	defer cleanup()
	if err = checkDocker(); err != nil {
		return err
	}
	if err = privateConfig(o.directory); err != nil {
		return err
	}
	lock, err := lockInstance(o.directory)
	if err != nil {
		return err
	}
	defer func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() }()
	j, err := readUpgradeJournal(o.directory)
	if err != nil {
		return err
	}
	if j.OriginalVersion != r.manifest.Version {
		return errors.New("original release differs from operation journal")
	}
	if j.Phase == "verified" || j.Phase == "resume-intent" || j.Phase == "complete" {
		return reconcileVerifiedUpgrade(o, key, j, candidateBundle, candidateManifest)
	}
	if j.OriginalVersion != r.manifest.Version || (j.Phase != "pause-intent" && j.Phase != "paused") {
		return errors.New("replacement may have started; recover-upgrade refuses image-only rollback; explicitly restore the retained backup and original bundle")
	}
	current, err := validateCurrentRuntime(o, r)
	if err != nil {
		return err
	}
	if _, err = invokeCompose(o.directory, current, "nevix", "up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "server"); err != nil {
		return errors.New("original Server recovery failed; pause retained")
	}
	if _, err = invokeCompose(o.directory, current, "nevix", "restart", "nginx"); err != nil {
		return err
	}
	if err = waitRunningRelease(o.client, r, 20*time.Second); err != nil {
		return err
	}
	s, err := o.client.snapshot()
	if err != nil {
		return err
	}
	revision := j.Revision
	if j.Phase == "pause-intent" {
		revision++
	}
	if s.Paused {
		if s.Owner == nil || *s.Owner != j.Owner || s.Revision != revision {
			return errors.New("maintenance belongs to a different transition; recovery refused")
		}
		if err = o.client.resume(s); err != nil {
			return err
		}
	} else if !(j.Phase == "pause-intent" && s.Revision == j.Revision) && (s.Owner == nil || *s.Owner != j.Owner || s.Revision != revision+1) {
		return errors.New("maintenance revision changed; recovery refused")
	}
	if err = os.Remove(filepath.Join(o.directory, "upgrade.json")); err != nil {
		return err
	}
	fmt.Println("recovered original Nevix", r.manifest.Version, "before replacement; rerun upgrade with a new backup path")
	return nil
}

func captureUpgradeHistory(c *maintenanceClient) (map[string]publicView, error) {
	views := map[string]publicView{}
	for _, path := range []string{"/identity/users/me", "/creation/sessions"} {
		b, status, err := c.request("GET", path, nil)
		if err != nil || status != 200 {
			return nil, errors.New("public historical business state unavailable")
		}
		var value any
		if json.Unmarshal(b, &value) != nil {
			return nil, errors.New("invalid public historical business state")
		}
		canonical, _ := json.Marshal(value)
		views[path] = publicView{status, hashBytes(canonical)}
	}
	return views, nil
}

func outsideInstanceBackup(directory, backup string) error {
	instance, err := filepath.Abs(directory)
	if err != nil {
		return err
	}
	instance, err = filepath.EvalSymlinks(instance)
	if err != nil {
		return err
	}
	path, err := filepath.Abs(backup)
	if err != nil {
		return err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(instance, filepath.Join(parent, filepath.Base(path)))
	if err != nil {
		return err
	}
	if relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("backup must be outside instance directory, including aliases")
	}
	return nil
}

func removeUpgradeJournal(directory string) error {
	if err := os.Remove(filepath.Join(directory, "upgrade.json")); err != nil {
		return err
	}
	d, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func reconcileVerifiedUpgrade(o backupOptions, key string, j upgradeJournal, bundle, manifest string) (retErr error) {
	if bundle == "" || manifest == "" {
		return errors.New("verified upgrade reconciliation requires its signed candidate --bundle and --manifest")
	}
	candidate, cleanup, err := verifiedBackupRuntime(bundle, manifest, key)
	if err != nil {
		return err
	}
	defer cleanup()
	if candidate.manifest.Version != j.CandidateVersion {
		return errors.New("candidate differs from verified upgrade journal")
	}
	current, err := validateInstalledRuntime(o.directory, candidate)
	if err != nil {
		return err
	}
	pointer, err := os.ReadFile(filepath.Join(o.directory, "current"))
	if err != nil {
		return err
	}
	if v := strings.TrimSpace(string(pointer)); v != j.CandidateVersion && v != j.OriginalVersion {
		return errors.New("installed current pointer changed since upgrade")
	}
	// A durable verified/resume-intent phase proves replacement validation finished. Reconcile
	// that exact transition without restoring old data or discarding legitimate post-resume writes.
	defer func() {
		if retErr != nil {
			_, e := invokeCompose(o.directory, current, "nevix", "stop", "server", "nginx")
			retErr = errors.Join(retErr, fmt.Errorf("verified upgrade reconciliation failed; Server/edge stopped, journal retained (stop result: %v)", e))
		}
	}()
	if _, err = invokeCompose(o.directory, current, "nevix", "up", "--detach", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "server"); err != nil {
		return err
	}
	if _, err = invokeCompose(o.directory, current, "nevix", "up", "--detach", "--no-deps", "--no-build", "--pull", "never", "nginx"); err != nil {
		return err
	}
	if _, err = invokeCompose(o.directory, current, "nevix", "restart", "nginx"); err != nil {
		return err
	}
	if err = waitRunningRelease(o.client, candidate, 20*time.Second); err != nil {
		return err
	}
	state, err := o.client.snapshot()
	if err != nil {
		return err
	}
	if state.Owner == nil || *state.Owner != j.Owner || (state.Paused && state.Revision != j.Revision) || (!state.Paused && state.Revision != j.Revision+1) {
		return errors.New("verified upgrade maintenance belongs to another transition")
	}
	stage, err := os.MkdirTemp("", "nevix-upgrade-reconcile-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err = copyVolumeSnapshot(candidate.identities["cert-init"], "nevix_secrets", stage, "secrets", true); err != nil {
		return err
	}
	if err = verifyRestoredCredentials(o.directory, current, "nevix", stage); err != nil {
		return err
	}
	if err = replacePrivateFile(o.directory, "current", []byte(j.CandidateVersion+"\n")); err != nil {
		return err
	}
	if state.Paused {
		if !state.Drained || state.NonTerminal != 0 {
			return errors.New("verified upgrade unexpectedly has nonterminal tasks while paused")
		}
		j.Phase = "resume-intent"
		if err = writeUpgradeJournal(o.directory, j); err != nil {
			return err
		}
		if err = o.client.resume(state); err != nil {
			return err
		}
	}
	j.Phase = "complete"
	if err = writeUpgradeJournal(o.directory, j); err != nil {
		return err
	}
	if err = removeUpgradeJournal(o.directory); err != nil {
		return err
	}
	fmt.Println("reconciled verified Nevix", j.CandidateVersion, "upgrade without database restore; current business writes retained")
	return nil
}
