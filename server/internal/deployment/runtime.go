package deployment

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/nevix-ai/server/internal/release"
)

func docker(args ...string) ([]byte, error) {
	cmd := exec.Command("docker", args...)
	b, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker %s failed: %s", args[0], strings.TrimSpace(string(b)))
	}
	return b, nil
}
func checkDocker() error {
	b, err := docker("version", "--format", "{{json .Server}}")
	if err != nil {
		return err
	}
	var server struct {
		Version    string
		Os         string
		Arch       string
		APIVersion string `json:"ApiVersion"`
	}
	if json.Unmarshal(b, &server) != nil || server.Os != "linux" || server.Arch != "amd64" {
		return errors.New("deployment requires a Linux amd64 Docker Engine")
	}
	// --platform inspect needs Engine API 1.49; save/load filtering needs 1.48.
	parts := strings.Split(server.APIVersion, ".")
	minor := 0
	if len(parts) == 2 {
		minor, _ = strconv.Atoi(parts[1])
	}
	if len(parts) != 2 || parts[0] != "1" || minor < 49 {
		return errors.New("Docker Engine API >= 1.49 (Engine >= 28.2) required")
	}
	b, err = docker("compose", "version", "--short")
	if err != nil {
		return err
	}
	version := strings.TrimPrefix(strings.TrimSpace(string(b)), "v")
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(version) {
		return errors.New("unknown Docker Compose version")
	}
	cmp, err := release.CompareVersions(version, "2.38.0")
	if err != nil || cmp < 0 {
		return errors.New("Docker Compose >= 2.38.0 required")
	}
	return nil
}
func inspectImages(inv inventory) (map[string]string, error) {
	identities := map[string]string{}
	for _, im := range inv.Images {
		b, err := docker("image", "inspect", "--platform", "linux/amd64", im.Tag)
		if err != nil {
			return nil, err
		}
		var actual []struct {
			ID           string `json:"Id"`
			OS           string `json:"Os"`
			Architecture string
			RootFS       struct{ Layers []string }
		}
		if json.Unmarshal(b, &actual) != nil || len(actual) != 1 || actual[0].OS != "linux" || actual[0].Architecture != "amd64" || (actual[0].ID != im.ConfigDigest && actual[0].ID != im.ManifestDigest) || !equalStrings(actual[0].RootFS.Layers, im.Layers) {
			return nil, fmt.Errorf("local image identity mismatch for %s", im.Service)
		}
		identities[im.Service] = actual[0].ID
	}
	return identities, nil
}
func renderCompose(directory string, identities map[string]string) ([]byte, error) {
	b, err := os.ReadFile(filepath.Join(directory, "compose.template.yaml"))
	if err != nil {
		return nil, err
	}
	text := string(b)
	for _, service := range []string{"server", "cert-init", "postgres", "nginx"} {
		placeholder := "@" + strings.ToUpper(strings.ReplaceAll(service, "-", "_")) + "_IMAGE@"
		if !strings.Contains(text, placeholder) || !digestPattern.MatchString(identities[service]) {
			return nil, errors.New("invalid runtime Compose image template")
		}
		text = strings.ReplaceAll(text, placeholder, identities[service])
	}
	if strings.Contains(text, "_IMAGE@") || strings.Contains(text, "build:") || !strings.Contains(text, "name: nevix\n") || strings.Count(text, "pull_policy: never") != 5 || strings.Count(text, "platform: linux/amd64") != 5 {
		return nil, errors.New("runtime Compose must forbid build/pull and pin five services")
	}
	return []byte(text), nil
}
func privateConfig(directory string) error {
	st, err := os.Lstat(filepath.Join(directory, ".env"))
	if err != nil {
		return fmt.Errorf("create customer .env from .env.example with permissions 0600 before install: %w", err)
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 {
		return errors.New("customer .env must be a private regular file (0600)")
	}
	b, err := os.ReadFile(filepath.Join(directory, ".env"))
	if err != nil {
		return err
	}
	if strings.Contains(string(b), "change-me-") {
		return errors.New("replace example passwords in customer .env")
	}
	return nil
}
func importRuntime(command, stage, directory string, envelope []byte, manifest release.Manifest, inv inventory) error {
	if err := checkDocker(); err != nil {
		return err
	}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return err
	}
	releaseDir := filepath.Join(absolute, "releases", manifest.Version)
	existing := false
	if st, statErr := os.Lstat(releaseDir); statErr == nil {
		if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return errors.New("release destination must be a regular directory")
		}
		existing = true
	} else if !os.IsNotExist(statErr) {
		return statErr
	}
	if command == "install" {
		if err = privateConfig(absolute); err != nil {
			return err
		}
		// Install is for an empty instance only; volume presence requires the upgrade/restore path.
		for _, name := range []string{"nevix_pgdata", "nevix_tls", "nevix_secrets"} {
			b, err := docker("volume", "ls", "--format", "{{.Name}}", "--filter", "name=^"+name+"$")
			if err != nil {
				return err
			}
			if strings.TrimSpace(string(b)) != "" {
				return errors.New("existing Nevix volumes: use the upgrade/restore command")
			}
		}
	}
	if _, err = docker("image", "load", "--platform", "linux/amd64", "--input", filepath.Join(stage, "images.tar")); err != nil {
		return err
	}
	identities, err := inspectImages(inv)
	if err != nil {
		return err
	}
	compose, err := renderCompose(stage, identities)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Join(absolute, "releases"), 0700); err != nil {
		return err
	}
	// Create the release in its final filesystem, then rename only when complete.
	pending, err := os.MkdirTemp(filepath.Join(absolute, "releases"), ".import-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(pending)
	for name := range bundleFiles {
		if name == "images.tar" {
			continue
		} // Keep the original signed archive separately for disaster recovery.
		b, err := os.ReadFile(filepath.Join(stage, name))
		if err != nil {
			return err
		}
		target := filepath.Join(pending, name)
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
		if err = os.WriteFile(target, b, mode); err != nil {
			return err
		}
	}
	if err = os.WriteFile(filepath.Join(pending, "release.json"), envelope, 0600); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(pending, "compose.yaml"), compose, 0600); err != nil {
		return err
	}
	if existing {
		for name := range bundleFiles {
			if name == "images.tar" {
				continue
			}
			want, err := os.ReadFile(filepath.Join(pending, name))
			if err != nil {
				return err
			}
			st, err := os.Lstat(filepath.Join(releaseDir, name))
			if err != nil || !st.Mode().IsRegular() {
				return errors.New("existing release was modified")
			}
			have, err := os.ReadFile(filepath.Join(releaseDir, name))
			if err != nil || !bytes.Equal(have, want) {
				return errors.New("existing release was modified")
			}
		}
		for _, name := range []string{"release.json", "compose.yaml"} {
			want, err := os.ReadFile(filepath.Join(pending, name))
			if err != nil {
				return err
			}
			have, err := os.ReadFile(filepath.Join(releaseDir, name))
			if err != nil || !bytes.Equal(have, want) {
				return errors.New("existing release was modified")
			}
		}
	} else if err = os.Rename(pending, releaseDir); err != nil {
		return err
	}
	example, err := os.ReadFile(filepath.Join(stage, ".env.example"))
	if err != nil {
		return err
	}
	template, err := os.OpenFile(filepath.Join(absolute, ".env.example"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		_, writeErr := template.Write(example)
		closeErr := template.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
	} else if !os.IsExist(err) {
		return err
	}
	if command == "install" {
		if _, err = docker("compose", "--project-name", "nevix", "--env-file", filepath.Join(absolute, ".env"), "-f", filepath.Join(releaseDir, "compose.yaml"), "up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180"); err != nil {
			return fmt.Errorf("installation stopped; inspect Compose logs, volumes are retained: %w", err)
		}
		// The running Server must advertise the signed target identity, not merely answer /health.
		b, err := docker("compose", "--project-name", "nevix", "--env-file", filepath.Join(absolute, ".env"), "-f", filepath.Join(releaseDir, "compose.yaml"), "exec", "-T", "server", "wget", "-qO-", "http://127.0.0.1:8080/release/version")
		if err != nil {
			return err
		}
		var running struct {
			Service           string `json:"service"`
			Version           string `json:"version"`
			MinDesktopVersion string `json:"min_desktop_version"`
		}
		if json.Unmarshal(b, &running) != nil || running.Service != "nevix-server" || running.Version != manifest.Version || running.MinDesktopVersion != manifest.MinDesktopVersion {
			_, stopErr := docker("compose", "--project-name", "nevix", "--env-file", filepath.Join(absolute, ".env"), "-f", filepath.Join(releaseDir, "compose.yaml"), "stop", "server", "nginx")
			return fmt.Errorf("running Server identity differs from signed release; stopped Server/edge, inspect logs (stop result: %v)", stopErr)
		}
		if err = os.WriteFile(filepath.Join(absolute, "current"), []byte(manifest.Version+"\n"), 0600); err != nil {
			return err
		}
	}
	fmt.Println("imported Nevix", manifest.Version, "at", releaseDir)
	return nil
}
