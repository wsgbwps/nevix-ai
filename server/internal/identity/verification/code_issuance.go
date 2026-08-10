// Package verification is the identity Module's command layer: one-time
// verification code issuance with synchronous rate limiting. A rejected
// command writes no domain state and no Outbox row.
package verification

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/identity/command"
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

// cooldownActiveError carries the seconds a caller must wait before another
// issuance. MapError turns that domain value into the Retry-After header.
type cooldownActiveError struct {
	retryAfter int
}

func (e *cooldownActiveError) Error() string {
	return "identity: resend cooldown active"
}

// Synchronous rejection reasons of the issuance command.
var (
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

// IssueVerificationCodeRequest is the IssueVerificationCode command input.
// ClientIP is supplied by the transport adapter and never decoded from JSON.
type IssueVerificationCodeRequest struct {
	Email    string `json:"email"`
	ClientIP string `json:"-"`
}

// Validate normalizes a bare email address before the command can use it.
func (r *IssueVerificationCodeRequest) Validate() *command.Error {
	normalized, err := NormalizeEmail(r.Email)
	if err != nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_email", Message: "email must be a bare address like user@example.com."}
	}
	r.Email = normalized
	return nil
}

// IssueVerificationCodeResponse acknowledges that a code-carrying email was
// queued without exposing the plaintext code.
type IssueVerificationCodeResponse struct {
	Status string `json:"status"`
}

// IssueVerificationCode runs the trusted command after the shared skeleton
// has decoded and validated its request.
func (i *CodeIssuer) IssueVerificationCode(ctx context.Context, req IssueVerificationCodeRequest) (IssueVerificationCodeResponse, error) {
	if err := i.issue(ctx, req.Email, req.ClientIP); err != nil {
		return IssueVerificationCodeResponse{}, err
	}
	return IssueVerificationCodeResponse{Status: "issued"}, nil
}

// MapError translates issuance-domain errors to the trusted-command contract.
// Unrecognized failures are logged and mapped to 500 by command.
func MapError(err error) *command.Error {
	var cooldown *cooldownActiveError
	switch {
	case errors.As(err, &cooldown):
		return &command.Error{
			Status:  http.StatusTooManyRequests,
			Code:    "cooldown_active",
			Message: "A code was sent less than 60 seconds ago; wait for it before resending.",
			Headers: map[string]string{"Retry-After": strconv.Itoa(cooldown.retryAfter)},
		}
	case errors.Is(err, errEmailRateLimited):
		return &command.Error{Status: http.StatusTooManyRequests, Code: "email_rate_limited", Message: "This email reached the limit of 5 codes per hour; try again later."}
	case errors.Is(err, errIPRateLimited):
		return &command.Error{Status: http.StatusTooManyRequests, Code: "ip_rate_limited", Message: "Too many code requests from this network; try again later."}
	default:
		return nil
	}
}

// issue runs the synchronous command transaction: enforce cooldown and rate
// limits, supersede the previous code, store the new code's hash, and queue
// the code-carrying email in the same Outbox transaction. A rejected command
// writes nothing. A cooldown error carries its retry-after seconds.
func (i *CodeIssuer) issue(ctx context.Context, email, ip string) error {
	tx, err := i.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("identity: begin code issuance: %w", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	// Serialize concurrent issuance per email and per IP: without these
	// transaction-scoped locks, simultaneous requests could both pass the
	// cooldown and limit checks before either writes. Every transaction
	// locks email first, then IP, so lock ordering cannot deadlock.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, email); err != nil {
		return fmt.Errorf("identity: lock issuance for email: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, ip); err != nil {
		return fmt.Errorf("identity: lock issuance for IP: %w", err)
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
		 WHERE email = $1 AND action_type IS NULL`, email, rateLimitWindow.Seconds(),
	).Scan(&dbNow, &emailCount, &lastIssued)
	if err != nil {
		return fmt.Errorf("identity: read issuance history: %w", err)
	}
	if lastIssued != nil {
		if remaining := resendCooldown - dbNow.Sub(*lastIssued); remaining > 0 {
			return &cooldownActiveError{retryAfter: int(math.Ceil(remaining.Seconds()))}
		}
	}
	if emailCount >= emailHourlyLimit {
		return errEmailRateLimited
	}

	var ipCount int
	err = tx.QueryRow(ctx,
		`SELECT count(*) FROM identity.verification_codes
		 WHERE request_ip = $1 AND action_type IS NULL AND created_at > now() - make_interval(secs => $2)`, ip, rateLimitWindow.Seconds(),
	).Scan(&ipCount)
	if err != nil {
		return fmt.Errorf("identity: read IP issuance history: %w", err)
	}
	if ipCount >= ipHourlyLimit {
		return errIPRateLimited
	}

	code, err := NewSixDigitCode()
	if err != nil {
		return fmt.Errorf("identity: generate code: %w", err)
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
		     WHERE email = $1 AND action_type IS NULL AND status = 'active')`, email,
	); err != nil {
		return fmt.Errorf("identity: cancel superseded code email: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE identity.verification_codes
		 SET status = 'superseded', superseded_at = now()
		 WHERE email = $1 AND action_type IS NULL AND status = 'active'`, email,
	); err != nil {
		return fmt.Errorf("identity: supersede previous code: %w", err)
	}
	var codeID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO identity.verification_codes (email, code_hash, request_ip, expires_at)
		 VALUES ($1, $2, $3, now() + make_interval(secs => $4))
		 RETURNING id`, email, HashCode(i.cfg.HashKey, code), ip, codeValidity.Seconds(),
	).Scan(&codeID); err != nil {
		return fmt.Errorf("identity: store code hash: %w", err)
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
		return fmt.Errorf("identity: queue code email: %w", err)
	}

	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		return fmt.Errorf("identity: commit code issuance: %w", err)
	}
	return nil
}

// NormalizeEmail accepts a bare RFC 5322 address and returns it lowercased;
// display-name forms and junk around the address are rejected.
func NormalizeEmail(raw string) (string, error) {
	addr, err := mail.ParseAddress(strings.TrimSpace(raw))
	if err != nil || addr.Name != "" || !strings.EqualFold(addr.Address, strings.TrimSpace(raw)) {
		return "", errors.New("identity: not a bare email address")
	}
	return strings.ToLower(addr.Address), nil
}

func NewSixDigitCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// HashCode turns a six-digit code into its stored form: HMAC-SHA256 keyed by
// the deployment hash key, hex-encoded.
func HashCode(key []byte, code string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(code))
	return hex.EncodeToString(mac.Sum(nil))
}
