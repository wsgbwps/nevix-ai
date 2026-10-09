package deployment

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

type descriptor struct {
	Digest    string `json:"digest"`
	Size      int64  `json:"size"`
	MediaType string `json:"mediaType"`
	Platform  struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
	} `json:"platform"`
	Annotations map[string]string `json:"annotations"`
}
type savedImage struct {
	Config   string
	RepoTags []string
	Layers   []string
}
type imageArchive struct {
	saved       []savedImage
	descriptors []descriptor
	blobs       map[string]int64
	json        map[string][]byte
}

func readImageArchive(path string) (imageArchive, error) {
	result := imageArchive{blobs: map[string]int64{}, json: map[string][]byte{}}
	f, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer f.Close()
	tr := tar.NewReader(f)
	seen := map[string]bool{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return result, err
		}
		if (h.Name == "blobs/" || h.Name == "blobs/sha256/") && h.Typeflag == tar.TypeDir {
			continue
		}
		digest := "sha256:" + strings.TrimPrefix(h.Name, "blobs/sha256/")
		isBlob := strings.HasPrefix(h.Name, "blobs/sha256/") && digestPattern.MatchString(digest)
		if seen[h.Name] || h.Typeflag != tar.TypeReg || h.Size < 0 || h.Size > 12<<30 || h.Linkname != "" || (!isBlob && h.Name != "index.json" && h.Name != "manifest.json" && h.Name != "oci-layout") || len(seen) > 256 {
			return result, fmt.Errorf("invalid image archive entry %q", h.Name)
		}
		seen[h.Name] = true
		if !isBlob || h.Size <= 1<<20 {
			if h.Size > 1<<20 {
				return result, errors.New("image metadata too large")
			}
			b, err := io.ReadAll(tr)
			if err != nil {
				return result, err
			}
			result.json[h.Name] = b
			if isBlob {
				sum := sha256.Sum256(b)
				if "sha256:"+hex.EncodeToString(sum[:]) != digest {
					return result, errors.New("image blob digest mismatch")
				}
			}
		} else {
			hash := sha256.New()
			if _, err = io.Copy(hash, tr); err != nil {
				return result, err
			}
			if "sha256:"+hex.EncodeToString(hash.Sum(nil)) != digest {
				return result, errors.New("image blob digest mismatch")
			}
		}
		if isBlob {
			result.blobs[digest] = h.Size
		}
	}
	var index struct {
		SchemaVersion int          `json:"schemaVersion"`
		Manifests     []descriptor `json:"manifests"`
	}
	if json.Unmarshal(result.json["index.json"], &index) != nil || index.SchemaVersion != 2 || (len(index.Manifests) < 4 || len(index.Manifests) > 12) || json.Unmarshal(result.json["manifest.json"], &result.saved) != nil || len(result.saved) != 4 || string(result.json["oci-layout"]) != "{\"imageLayoutVersion\":\"1.0.0\"}" {
		return result, errors.New("expected four-image OCI/Docker archive")
	}
	runtime := map[string]bool{}
	for _, desc := range index.Manifests {
		if desc.Annotations["io.containerd.image.name"] != "" {
			if desc.Platform.OS != "linux" || desc.Platform.Architecture != "amd64" {
				return result, errors.New("unexpected runnable image platform")
			}
			result.descriptors = append(result.descriptors, desc)
			runtime[desc.Digest] = true
		}
	}
	if len(result.descriptors) != 4 {
		return result, errors.New("expected exactly four runnable images")
	}
	// Docker save retains upstream SBOM/provenance referrers even with --platform.
	for _, desc := range index.Manifests {
		if desc.Annotations["io.containerd.image.name"] != "" {
			continue
		}
		if !runtime[desc.Annotations["io.containerd.manifest.subject"]] || desc.Platform.OS != "" || desc.Platform.Architecture != "" || !digestPattern.MatchString(desc.Digest) || result.blobs[desc.Digest] != desc.Size {
			return result, errors.New("unexpected image descriptor")
		}
		var auxiliary struct {
			Config descriptor   `json:"config"`
			Layers []descriptor `json:"layers"`
		}
		if json.Unmarshal(result.json["blobs/sha256/"+strings.TrimPrefix(desc.Digest, "sha256:")], &auxiliary) != nil || len(auxiliary.Layers) == 0 {
			return result, errors.New("invalid upstream image attestation")
		}
		var config struct {
			Architecture string `json:"architecture"`
			OS           string `json:"os"`
		}
		if !digestPattern.MatchString(auxiliary.Config.Digest) || result.blobs[auxiliary.Config.Digest] != auxiliary.Config.Size || json.Unmarshal(result.json["blobs/sha256/"+strings.TrimPrefix(auxiliary.Config.Digest, "sha256:")], &config) != nil || config.Architecture != "unknown" || config.OS != "unknown" {
			return result, errors.New("attestation must not be a runnable image")
		}
		for _, layer := range auxiliary.Layers {
			if layer.MediaType != "application/vnd.in-toto+json" || !digestPattern.MatchString(layer.Digest) || result.blobs[layer.Digest] != layer.Size {
				return result, errors.New("invalid attestation layer")
			}
		}
	}
	return result, nil
}
func (a imageArchive) imageFor(tag string) (image, error) {
	var result image
	result.Tag = tag
	for _, desc := range a.descriptors {
		if desc.Annotations["io.containerd.image.name"] != "docker.io/library/"+tag {
			continue
		}
		if result.ManifestDigest != "" || desc.Platform.OS != "linux" || desc.Platform.Architecture != "amd64" {
			return result, errors.New("duplicate or wrong-platform image")
		}
		result.ManifestDigest = desc.Digest
		if a.blobs[desc.Digest] != desc.Size || !digestPattern.MatchString(desc.Digest) {
			return result, errors.New("missing platform manifest")
		}
		var manifest struct {
			Config descriptor   `json:"config"`
			Layers []descriptor `json:"layers"`
		}
		if json.Unmarshal(a.json["blobs/sha256/"+strings.TrimPrefix(desc.Digest, "sha256:")], &manifest) != nil {
			return result, errors.New("invalid platform manifest")
		}
		result.ConfigDigest = manifest.Config.Digest
		if a.blobs[manifest.Config.Digest] != manifest.Config.Size || !digestPattern.MatchString(result.ConfigDigest) {
			return result, errors.New("missing image config")
		}
		var config struct {
			OS           string `json:"os"`
			Architecture string `json:"architecture"`
			RootFS       struct {
				DiffIDs []string `json:"diff_ids"`
			} `json:"rootfs"`
		}
		if json.Unmarshal(a.json["blobs/sha256/"+strings.TrimPrefix(result.ConfigDigest, "sha256:")], &config) != nil || config.OS != "linux" || config.Architecture != "amd64" || len(config.RootFS.DiffIDs) == 0 || len(config.RootFS.DiffIDs) != len(manifest.Layers) {
			return result, errors.New("invalid image config platform/layers")
		}
		result.OS = config.OS
		result.Architecture = config.Architecture
		result.Layers = config.RootFS.DiffIDs
		for _, layer := range manifest.Layers {
			if !digestPattern.MatchString(layer.Digest) || a.blobs[layer.Digest] != layer.Size {
				return result, errors.New("missing image layer")
			}
		}
		matches := 0
		for _, saved := range a.saved {
			if len(saved.RepoTags) != 1 || saved.RepoTags[0] != tag {
				continue
			}
			matches++
			if saved.Config != "blobs/sha256/"+strings.TrimPrefix(result.ConfigDigest, "sha256:") || len(saved.Layers) != len(manifest.Layers) {
				return result, errors.New("Docker image mapping differs from OCI identity")
			}
			for i, layer := range manifest.Layers {
				if saved.Layers[i] != "blobs/sha256/"+strings.TrimPrefix(layer.Digest, "sha256:") {
					return result, errors.New("Docker image mapping differs from OCI layers")
				}
			}
		}
		if matches != 1 {
			return result, errors.New("missing Docker image mapping")
		}
	}
	if result.ManifestDigest == "" {
		return result, errors.New("missing tagged platform image")
	}
	return result, nil
}
func validateImageArchive(path string, inv inventory) error {
	archive, err := readImageArchive(path)
	if err != nil {
		return err
	}
	for _, expected := range inv.Images {
		actual, err := archive.imageFor(expected.Tag)
		if err != nil {
			return err
		}
		if actual.ConfigDigest != expected.ConfigDigest || actual.ManifestDigest != expected.ManifestDigest || !equalStrings(actual.Layers, expected.Layers) {
			return errors.New("image archive disagrees with signed inventory")
		}
	}
	return nil
}
