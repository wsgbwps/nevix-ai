package deployment

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"
)

var (
	errCustomerPin             = errors.New("customer TLS fingerprint changed")
	errCustomerHostname        = errors.New("customer TLS hostname mismatch")
	errCustomerCertificateTime = errors.New("customer TLS certificate expired or not yet valid")
)

type maintenanceSnapshot struct {
	Paused      bool    `json:"paused"`
	Owner       *string `json:"owner_token"`
	Revision    int64   `json:"revision"`
	NonTerminal int64   `json:"non_terminal_tasks"`
	Drained     bool    `json:"drained"`
}
type maintenanceClient struct {
	url, token, pin string
	client          *http.Client
}

func privateFile(path string, limit int64) ([]byte, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > limit {
		return nil, errors.New("credential/config must be a private regular file (0600)")
	}
	return os.ReadFile(path)
}
func newMaintenanceClient(base, pin, tokenFile string) (*maintenanceClient, error) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("customer Server URL must be an absolute HTTPS origin")
	}
	pin = strings.ToLower(strings.ReplaceAll(pin, ":", ""))
	if b, e := hex.DecodeString(pin); e != nil || len(b) != 32 {
		return nil, errors.New("customer TLS SHA-256 fingerprint required; obtain it independently")
	}
	b := []byte{}
	if tokenFile != "" {
		b, err = privateFile(tokenFile, 4096)
	}
	if err != nil {
		return nil, err
	}
	token := strings.TrimSpace(string(b))
	clear(b)
	if (tokenFile != "" && token == "") || strings.ContainsAny(token, "\r\n\t ") {
		return nil, errors.New("invalid Admin session file")
	}
	c := &maintenanceClient{url: strings.TrimRight(base, "/"), token: token, pin: pin}
	// Exact customer pin replaces CA trust, while hostname and validity remain mandatory.
	tr := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, VerifyConnection: func(cs tls.ConnectionState) error {
		if len(cs.PeerCertificates) == 0 {
			return errors.New("customer TLS certificate absent")
		}
		cert := cs.PeerCertificates[0]
		sum := sha256.Sum256(cert.Raw)
		if hex.EncodeToString(sum[:]) != pin {
			return errCustomerPin
		}
		if err := cert.VerifyHostname(u.Hostname()); err != nil {
			return errCustomerHostname
		}
		now := time.Now()
		if now.Before(cert.NotBefore) || !now.Before(cert.NotAfter) {
			return errCustomerCertificateTime
		}
		return nil
	}}}
	c.client = &http.Client{Transport: tr, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("customer HTTP redirects refused") }}
	return c, nil
}
func (c *maintenanceClient) request(method, path string, body any) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.url+path, reader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.client.Do(req)
	if err != nil {
		category := "transport"
		switch {
		case errors.Is(err, errCustomerPin):
			category = "tls-pin"
		case errors.Is(err, errCustomerHostname):
			category = "tls-hostname"
		case errors.Is(err, errCustomerCertificateTime):
			category = "tls-validity"
		case errors.Is(err, syscall.ECONNREFUSED):
			category = "connection-refused"
		case errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH):
			category = "route-unreachable"
		default:
			var networkError net.Error
			if errors.As(err, &networkError) && networkError.Timeout() {
				category = "timeout"
			}
		}
		return nil, 0, fmt.Errorf("customer HTTPS request failed (%s); private transport details withheld", category)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 2<<20+1))
	if err != nil || len(b) > 2<<20 {
		return nil, res.StatusCode, errors.New("customer HTTP response exceeds limit")
	}
	if res.StatusCode != 200 && res.StatusCode != 404 {
		return nil, res.StatusCode, fmt.Errorf("customer HTTP request rejected (%d)", res.StatusCode)
	}
	return b, res.StatusCode, nil
}
func (c *maintenanceClient) snapshot() (maintenanceSnapshot, error) { return c.transition("", "", 0) }
func (c *maintenanceClient) transition(action, owner string, rev int64) (maintenanceSnapshot, error) {
	var s maintenanceSnapshot
	method := http.MethodGet
	path := "/creation/maintenance"
	var body any
	if action != "" {
		method = http.MethodPost
		path += "/" + action
		body = struct {
			Owner    string `json:"owner_token"`
			Revision int64  `json:"expected_revision"`
		}{owner, rev}
	}
	b, status, err := c.request(method, path, body)
	if err != nil {
		return s, err
	}
	if status != 200 || json.Unmarshal(b, &s) != nil || s.Revision < 0 || s.NonTerminal < 0 || s.Drained != (s.Paused && s.NonTerminal == 0) || (s.Paused && (s.Owner == nil || *s.Owner == "")) {
		return s, errors.New("invalid maintenance snapshot")
	}
	return s, nil
}
func operationID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
func (c *maintenanceClient) pauseAndDrain(timeout time.Duration) (maintenanceSnapshot, error) {
	return c.pauseAndDrainJournal(timeout, nil)
}
func (c *maintenanceClient) pauseAndDrainJournal(timeout time.Duration, intent func(string, int64) error) (maintenanceSnapshot, error) {
	before, err := c.snapshot()
	if err != nil {
		return before, err
	}
	if before.Paused {
		return maintenanceSnapshot{}, errors.New("instance already paused by another operation; refuse maintenance takeover")
	}
	owner, err := operationID()
	if err != nil {
		return before, err
	}
	if intent != nil {
		if err = intent(owner, before.Revision); err != nil {
			return maintenanceSnapshot{}, err
		}
	}
	s, err := c.transition("pause", owner, before.Revision)
	if err != nil { // Lost-response recovery may identify only this operation, never another owner's pause.
		recovered, e := c.snapshot()
		if e != nil || !recovered.Paused || recovered.Owner == nil || *recovered.Owner != owner || recovered.Revision != before.Revision+1 {
			return maintenanceSnapshot{}, err
		}
		s = recovered
	}
	if !s.Paused || s.Owner == nil || *s.Owner != owner || s.Revision != before.Revision+1 {
		return maintenanceSnapshot{}, errors.New("pause ownership mismatch")
	}
	deadline := time.Now().Add(timeout)
	for !s.Drained {
		if !time.Now().Before(deadline) {
			return s, errors.New("task drain timed out before replacement")
		}
		time.Sleep(250 * time.Millisecond)
		next, e := c.snapshot()
		if e != nil {
			return s, e
		}
		if !next.Paused || next.Owner == nil || *next.Owner != owner || next.Revision != s.Revision {
			return s, errors.New("maintenance ownership changed")
		}
		s = next
	}
	return s, nil
}
func (c *maintenanceClient) resume(s maintenanceSnapshot) error {
	if !s.Paused || s.Owner == nil {
		return errors.New("no owned pause to resume")
	}
	next, err := c.transition("resume", *s.Owner, s.Revision)
	if err != nil {
		recovered, e := c.snapshot()
		if e == nil && !recovered.Paused && recovered.Owner != nil && *recovered.Owner == *s.Owner && recovered.Revision == s.Revision+1 {
			return nil
		}
		return err
	}
	if next.Paused || next.Owner == nil || *next.Owner != *s.Owner || next.Revision != s.Revision+1 {
		return errors.New("resume ownership mismatch")
	}
	return nil
}
func certificateFingerprint(certPEM, keyPEM []byte) (string, error) {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil || len(pair.Certificate) == 0 {
		return "", errors.New("backup TLS certificate/private key mismatch")
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(sum[:]), nil
}

func (c *maintenanceClient) authenticate(credentials []byte) error {
	var input struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	d := json.NewDecoder(bytes.NewReader(credentials))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || input.Email == "" || input.Password == "" {
		return errors.New("private Admin credentials must contain email/password")
	}
	b, status, err := c.request("POST", "/identity/auth/login", input)
	input.Password = ""
	if err != nil || status != 200 {
		return errors.New("restored public Admin login failed; use credentials valid at backup time")
	}
	defer clear(b)
	var response struct {
		Token string `json:"token"`
	}
	if json.Unmarshal(b, &response) != nil || response.Token == "" {
		return errors.New("restored public login returned no session")
	}
	c.token = response.Token
	return nil
}
