package deployment

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"github.com/nevix-ai/server/internal/release"
)

const postgresSource = "postgres:17.5-alpine@sha256:6567bca8d7bc8c82c5922425a0baee57be8402df92bae5eacad5f01ae9544daa"
const nginxSource = "nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284"
const alpineSource = "alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1"
const goSource = "golang:1.26.3-alpine@sha256:91eda9776261207ea25fd06b5b7fed8d397dd2c0a283e77f2ab6e91bfa71079d"

var bundleFiles = map[string]int64{
	"bundle.json": 1 << 20, "compose.template.yaml": 1 << 20, "images.tar": 12 << 30,
	".env.example": 1 << 20, "nginx/nginx.conf": 1 << 20, "postgres/init-identity-app.sh": 1 << 20,
	"tools/nevix-deploy": 64 << 20, "README.md": 1 << 20,
}
var digestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var commitPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)

type image struct {
	Service        string   `json:"service"`
	Tag            string   `json:"tag"`
	ConfigDigest   string   `json:"config_digest"`
	ManifestDigest string   `json:"manifest_digest"`
	OS             string   `json:"os"`
	Architecture   string   `json:"architecture"`
	Layers         []string `json:"layers"`
	Provenance     []string `json:"provenance"`
}
type inventory struct {
	Format            string  `json:"format"`
	Version           string  `json:"version"`
	MinDesktopVersion string  `json:"min_desktop_version"`
	MinServerVersion  string  `json:"min_server_version"`
	SourceCommit      string  `json:"source_commit"`
	PostgresMajor     int     `json:"postgres_major"`
	Images            []image `json:"images"`
}

func readInventory(directory string, manifest release.Manifest) (inventory, error) {
	var result inventory
	b, err := os.ReadFile(filepath.Join(directory, "bundle.json"))
	if err != nil {
		return result, err
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if dec.Decode(&result) != nil {
		return result, errors.New("invalid bundle inventory")
	}
	canonical, err := json.Marshal(result)
	if err != nil || !bytes.Equal(bytes.TrimSpace(b), canonical) {
		return result, errors.New("noncanonical bundle inventory")
	}
	if result.Format != "nevix-runtime-v1" || result.Version != manifest.Version || result.MinDesktopVersion != manifest.MinDesktopVersion || result.MinServerVersion != manifest.MinServerVersion || !commitPattern.MatchString(result.SourceCommit) || result.PostgresMajor != 17 || len(result.Images) != 4 {
		return result, errors.New("bundle identity disagrees with signed release")
	}
	expected := map[string][]string{"server": {"git:" + result.SourceCommit + ":deploy/Dockerfile.server", goSource, alpineSource}, "cert-init": {"git:" + result.SourceCommit + ":deploy/cert-init/Dockerfile", alpineSource}, "postgres": {postgresSource}, "nginx": {nginxSource}}
	seen := map[string]bool{}
	for _, im := range result.Images {
		sources, ok := expected[im.Service]
		if !ok || seen[im.Service] || im.Tag != "nevix-bundle-"+im.Service+":"+result.Version || !digestPattern.MatchString(im.ConfigDigest) || !digestPattern.MatchString(im.ManifestDigest) || im.OS != "linux" || im.Architecture != "amd64" || len(im.Layers) == 0 || !equalStrings(im.Provenance, sources) {
			return result, errors.New("invalid image platform, identity or provenance")
		}
		seen[im.Service] = true
		for _, layer := range im.Layers {
			if !digestPattern.MatchString(layer) {
				return result, errors.New("invalid image layer identity")
			}
		}
	}
	return result, nil
}
func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Copy authenticated bytes into a private spool: later extraction never rereads a mutable input path.
func authenticatedSpool(bundlePath string, manifest release.Manifest) (*os.File, error) {
	in, err := os.Open(bundlePath)
	if err != nil {
		return nil, err
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() != manifest.Size {
		return nil, errors.New("bundle digest or size mismatch")
	}
	out, err := os.CreateTemp("", "nevix-authenticated-*.tar.gz")
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			out.Close()
			os.Remove(out.Name())
		}
	}()
	h := sha512.New()
	n, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(in, manifest.Size+1))
	if err != nil {
		return nil, err
	}
	if n != manifest.Size || base64.StdEncoding.EncodeToString(h.Sum(nil)) != manifest.SHA512 {
		return nil, errors.New("bundle digest or size mismatch")
	}
	if _, err = out.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	success = true
	return out, nil
}
func extractClosedBundle(spool *os.File, directory string) error {
	gz, err := gzip.NewReader(spool)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(io.LimitReader(gz, 13<<30))
	seen := map[string]bool{}
	for {
		entry, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		limit, allowed := bundleFiles[entry.Name]
		if !allowed || seen[entry.Name] || entry.Typeflag != tar.TypeReg || entry.Size < 0 || entry.Size > limit || entry.Linkname != "" {
			return fmt.Errorf("invalid archive entry %q", entry.Name)
		}
		seen[entry.Name] = true
		path := filepath.Join(directory, entry.Name)
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		mode := os.FileMode(0600)
		if entry.Name == "tools/nevix-deploy" {
			mode = 0700
		}
		if entry.Name == "postgres/init-identity-app.sh" {
			mode = 0755
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(f, tr)
		closeErr := f.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if len(seen) != len(bundleFiles) {
		return errors.New("incomplete runtime bundle")
	}
	// Consume the gzip trailer so a corrupt stream cannot be treated as complete.
	tail, err := io.ReadAll(io.LimitReader(gz, 1025))
	if err != nil {
		return err
	}
	if len(tail) > 1024 || len(bytes.Trim(tail, "\x00")) != 0 {
		return errors.New("unexpected data after runtime tar footer")
	}
	return nil
}
func verifyAndImport(command, bundlePath, directory string, envelope []byte, manifest release.Manifest) error {
	spool, err := authenticatedSpool(bundlePath, manifest)
	if err != nil {
		return err
	}
	defer func() { spool.Close(); os.Remove(spool.Name()) }()
	stage, err := os.MkdirTemp("", "nevix-verified-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err = extractClosedBundle(spool, stage); err != nil {
		return err
	}
	inv, err := readInventory(stage, manifest)
	if err != nil {
		return err
	}
	identities := map[string]string{}
	for _, im := range inv.Images {
		identities[im.Service] = im.ConfigDigest
	}
	if _, err = renderCompose(stage, identities); err != nil {
		return err
	}
	if err = validateImageArchive(filepath.Join(stage, "images.tar"), inv); err != nil {
		return err
	}
	if command == "verify" {
		fmt.Println("verified Nevix", manifest.Version, "linux/amd64 bundle")
		return nil
	}
	return importRuntime(command, stage, directory, envelope, manifest, inv)
}
