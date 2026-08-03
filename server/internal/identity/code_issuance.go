package identity

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/big"
	"net"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Rate-limit policy. The 60-second resend cooldown and the five-codes-per-
// email-hour cap are fixed by the resend-email-delivery spec; the per-IP
// hourly cap's value was left open there and confirmed with the spec author
// as 20. The command layer enforces all three synchronously: a rejected
// command writes no domain state and no Outbox row. codeValidity bounds a
// code's natural lifetime — and thereby the retry horizon of the email
// carrying it (ticket 05); its value was likewise confirmed with the spec
// author.
const (
	resendCooldown   = time.Minute
	rateLimitWindow  = time.Hour
	emailHourlyLimit = 5
	ipHourlyLimit    = 20
	codeValidity     = 10 * time.Minute
)

// Synchronous rejection reasons of the issuance command.
var (
	errCooldownActive   = errors.New("identity: resend cooldown active")
	errEmailRateLimited = errors.New("identity: email hourly limit reached")
	errIPRateLimited    = errors.New("identity: IP hourly limit reached")
)

// CodeIssuer is the identity command layer for one-time verification codes:
// it issues six-digit codes, stores only their HMAC hash, supersedes the
// previous code on resend, and leaves a code-carrying email in the Outbox —
// all in one transaction that first enforces the rate-limit policy.
type CodeIssuer struct {
	pool *pgxpool.Pool
	cfg  CodeIssuanceConfig
}

func NewCodeIssuer(pool *pgxpool.Pool, cfg CodeIssuanceConfig) *CodeIssuer {
	return &CodeIssuer{pool: pool, cfg: cfg}
}

type issueCodeRequest struct {
	Email string `json:"email"`
}

// ServeHTTP is the external issuance command. The response never carries the
// plaintext code: acceptance only acknowledges that the email was queued.
func (i *CodeIssuer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req issueCodeRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeIssueError(w, http.StatusBadRequest, "invalid_request", "Request body must be JSON with an email field.")
		return
	}
	email, err := normalizeEmail(req.Email)
	if err != nil {
		writeIssueError(w, http.StatusBadRequest, "invalid_email", "email must be a bare address like user@example.com.")
		return
	}

	retryAfter, err := i.issue(r.Context(), email, clientIP(r))
	switch {
	case errors.Is(err, errCooldownActive):
		w.Header().Set("Retry-After", fmt.Sprint(retryAfter))
		writeIssueError(w, http.StatusTooManyRequests, "cooldown_active", "A code was sent less than 60 seconds ago; wait for it before resending.")
	case errors.Is(err, errEmailRateLimited):
		writeIssueError(w, http.StatusTooManyRequests, "email_rate_limited", "This email reached the limit of 5 codes per hour; try again later.")
	case errors.Is(err, errIPRateLimited):
		writeIssueError(w, http.StatusTooManyRequests, "ip_rate_limited", "Too many code requests from this network; try again later.")
	case err != nil:
		slog.Error("identity: issue verification code", "email", email, "error", err)
		writeIssueError(w, http.StatusInternalServerError, "internal_error", "The code could not be issued.")
	default:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprint(w, `{"status":"issued"}`)
	}
}

// issue runs the synchronous command transaction: enforce cooldown and rate
// limits, supersede the previous code, store the new code's hash, and queue
// the code-carrying email in the same Outbox transaction. A rejected command
// writes nothing. retryAfter is meaningful only with errCooldownActive.
func (i *CodeIssuer) issue(ctx context.Context, email, ip string) (retryAfter int, err error) {
	tx, err := i.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("identity: begin code issuance: %w", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	// Serialize concurrent issuance per email and per IP: without these
	// transaction-scoped locks, simultaneous requests could both pass the
	// cooldown and limit checks before either writes. Every transaction
	// locks email first, then IP, so lock ordering cannot deadlock.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, email); err != nil {
		return 0, fmt.Errorf("identity: lock issuance for email: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, ip); err != nil {
		return 0, fmt.Errorf("identity: lock issuance for IP: %w", err)
	}

	var (
		dbNow      time.Time
		emailCount int
		lastIssued *time.Time
	)
	err = tx.QueryRow(ctx,
		`SELECT now(),
		        count(*) FILTER (WHERE created_at > now() - make_interval(secs => $2)),
		        max(created_at)
		 FROM identity.verification_codes
		 WHERE email = $1`, email, rateLimitWindow.Seconds(),
	).Scan(&dbNow, &emailCount, &lastIssued)
	if err != nil {
		return 0, fmt.Errorf("identity: read issuance history: %w", err)
	}
	if lastIssued != nil {
		if remaining := resendCooldown - dbNow.Sub(*lastIssued); remaining > 0 {
			return int(math.Ceil(remaining.Seconds())), errCooldownActive
		}
	}
	if emailCount >= emailHourlyLimit {
		return 0, errEmailRateLimited
	}

	var ipCount int
	err = tx.QueryRow(ctx,
		`SELECT count(*) FROM identity.verification_codes
		 WHERE request_ip = $1 AND created_at > now() - make_interval(secs => $2)`, ip, rateLimitWindow.Seconds(),
	).Scan(&ipCount)
	if err != nil {
		return 0, fmt.Errorf("identity: read IP issuance history: %w", err)
	}
	if ipCount >= ipHourlyLimit {
		return 0, errIPRateLimited
	}

	code, err := newSixDigitCode()
	if err != nil {
		return 0, fmt.Errorf("identity: generate code: %w", err)
	}

	// Superseding the previous code terminally cancels its undelivered email
	// in the same transaction: the user must never receive an already-invalid
	// code (ticket 05). The cancel runs while the old code is still active so
	// its subquery can find it.
	if _, err := tx.Exec(ctx,
		`UPDATE identity.outbox_messages
		 SET status = 'cancelled'
		 WHERE status = 'pending' AND verification_code_id IN (
		     SELECT id FROM identity.verification_codes
		     WHERE email = $1 AND status = 'active')`, email,
	); err != nil {
		return 0, fmt.Errorf("identity: cancel superseded code email: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE identity.verification_codes
		 SET status = 'superseded', superseded_at = now()
		 WHERE email = $1 AND status = 'active'`, email,
	); err != nil {
		return 0, fmt.Errorf("identity: supersede previous code: %w", err)
	}
	var codeID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO identity.verification_codes (email, code_hash, request_ip, expires_at)
		 VALUES ($1, $2, $3, now() + make_interval(secs => $4))
		 RETURNING id`, email, hashCode(i.cfg.HashKey, code), ip, codeValidity.Seconds(),
	).Scan(&codeID); err != nil {
		return 0, fmt.Errorf("identity: store code hash: %w", err)
	}
	// The plaintext code exists only here, in the Outbox payload of the email
	// that must carry it; it is never logged or returned to the caller. The
	// row is bound to the code it carries, bounding its retry horizon.
	body := fmt.Sprintf("Your verification code is: %s\n\nIf you did not request this code, you can ignore this email.\n", code)
	if _, err := tx.Exec(ctx,
		`INSERT INTO identity.outbox_messages (sender, recipient, subject, body, verification_code_id)
		 VALUES ($1, $2, $3, $4, $5)`,
		i.cfg.From, email, "Your Nevix verification code", body, codeID,
	); err != nil {
		return 0, fmt.Errorf("identity: queue code email: %w", err)
	}

	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		return 0, fmt.Errorf("identity: commit code issuance: %w", err)
	}
	return 0, nil
}

// normalizeEmail accepts a bare RFC 5322 address and returns it lowercased;
// display-name forms and junk around the address are rejected.
func normalizeEmail(raw string) (string, error) {
	addr, err := mail.ParseAddress(strings.TrimSpace(raw))
	if err != nil || addr.Name != "" || !strings.EqualFold(addr.Address, strings.TrimSpace(raw)) {
		return "", errors.New("identity: not a bare email address")
	}
	return strings.ToLower(addr.Address), nil
}

// clientIP takes the peer address of the connection. V1 has no trusted
// reverse proxy in front of the Go server, so forwarding headers are
// attacker-controlled and deliberately not consulted.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func newSixDigitCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// hashCode turns a six-digit code into its stored form: HMAC-SHA256 keyed by
// the deployment hash key, hex-encoded.
func hashCode(key []byte, code string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(code))
	return hex.EncodeToString(mac.Sum(nil))
}

func writeIssueError(w http.ResponseWriter, status int, errCode, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":%q,"message":%q}`, errCode, message)
}
