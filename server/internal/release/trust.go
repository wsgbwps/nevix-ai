package release

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type Manifest struct {
	Version           string `json:"version"`
	Channel           string `json:"channel"`
	Platform          string `json:"platform"`
	Arch              string `json:"arch"`
	MinServerVersion  string `json:"min_server_version"`
	MinDesktopVersion string `json:"min_desktop_version"`
	URL               string `json:"url"`
	Size              int64  `json:"size"`
	SHA512            string `json:"sha512"`
}

var stableVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func CompareVersions(left, right string) (int, error) {
	parse := func(value string) ([3]int64, error) {
		var result [3]int64
		if !stableVersion.MatchString(value) {
			return result, errors.New("unknown stable version")
		}
		for i, p := range strings.Split(value, ".") {
			n, err := strconv.ParseInt(p, 10, 32)
			if err != nil {
				return result, err
			}
			result[i] = n
		}
		return result, nil
	}
	a, err := parse(left)
	if err != nil {
		return 0, err
	}
	b, err := parse(right)
	if err != nil {
		return 0, err
	}
	for i := range a {
		if a[i] > b[i] {
			return 1, nil
		}
		if a[i] < b[i] {
			return -1, nil
		}
	}
	return 0, nil
}
func decodeBase64(value string, length int) ([]byte, error) {
	b, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || base64.StdEncoding.EncodeToString(b) != value || (length >= 0 && len(b) != length) {
		return nil, errors.New("invalid base64")
	}
	return b, nil
}
func Verify(envelope []byte, publicKeyPEM, platform, arch string) (Manifest, error) {
	var result Manifest
	fail := func() (Manifest, error) { return Manifest{}, errors.New("invalid signed release") }
	if len(envelope) > 64*1024 || publicKeyPEM == "" {
		return fail()
	}
	var outer struct {
		Format    string `json:"format"`
		Payload   string `json:"payload"`
		Signature string `json:"signature"`
	}
	decoder := json.NewDecoder(bytes.NewReader(envelope))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&outer) != nil || outer.Format != "nevix-release-v1" {
		return fail()
	}
	// Envelope canonical comparison rejects duplicates and trailing documents.
	canonical, err := json.Marshal(outer)
	if err != nil {
		return fail()
	}
	if !bytes.Equal(bytes.TrimSpace(envelope), canonical) {
		return fail()
	}
	b, err := decodeBase64(outer.Payload, -1)
	if err != nil {
		return fail()
	}
	sig, err := decodeBase64(outer.Signature, 64)
	if err != nil {
		return fail()
	}
	block, rest := pem.Decode([]byte(publicKeyPEM))
	if block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(rest)) != 0 {
		return fail()
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return fail()
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok || !ed25519.Verify(key, b, sig) {
		return fail()
	}
	decoder = json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil {
		return fail()
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(result) != nil || !bytes.Equal(bytes.TrimSuffix(buf.Bytes(), []byte("\n")), b) {
		return fail()
	}
	for _, char := range b {
		if char < 32 || char > 126 || char == 92 {
			return fail()
		}
	}
	if result.Channel != "stable" || result.Platform != platform || result.Arch != arch {
		return fail()
	}
	suffix := ""
	switch platform + "/" + arch {
	case "win32/x64":
		suffix = ".exe"
	case "darwin/arm64":
		suffix = ".zip"
	case "linux/amd64":
		suffix = ".tar.gz"
	default:
		return fail()
	}
	for _, v := range []string{result.Version, result.MinServerVersion, result.MinDesktopVersion} {
		if _, err = CompareVersions(v, "0.0.0"); err != nil {
			return fail()
		}
	}
	authority := strings.SplitN(strings.TrimPrefix(result.URL, "https://"), "/", 2)[0]
	if authority == "" || strings.ContainsAny(authority, "@%") {
		return fail()
	}
	for i := 0; i < len(result.URL); i++ {
		if result.URL[i] == '%' {
			if i+2 >= len(result.URL) {
				return fail()
			}
			if _, err := strconv.ParseUint(result.URL[i+1:i+3], 16, 8); err != nil {
				return fail()
			}
			i += 2
		}
	}
	u, err := url.Parse(result.URL)
	if err != nil || u.Scheme != "https" || !strings.HasPrefix(result.URL, "https://") || u.Hostname() == "" || u.User != nil || strings.Contains(result.URL, "#") || !(strings.HasSuffix(u.EscapedPath(), suffix) || (platform == "darwin" && strings.HasSuffix(u.EscapedPath(), ".dmg"))) || result.Size <= 0 || result.Size > 9007199254740991 {
		return fail()
	}
	if port := u.Port(); port != "" {
		if _, err := strconv.ParseUint(port, 10, 16); err != nil {
			return fail()
		}
	}
	if _, err = decodeBase64(result.SHA512, 64); err != nil {
		return fail()
	}
	return result, nil
}
