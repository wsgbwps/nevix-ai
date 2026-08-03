package identity

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wneessen/go-mail"
	"github.com/wneessen/go-mail/smtp"
)

// pollInterval is how long the Outbox Worker sleeps once the pending backlog
// is drained before polling again.
const pollInterval = time.Second

// OutboxWorker is a pure deliverer: it claims due pending
// identity.outbox_messages rows with FOR UPDATE SKIP LOCKED and sends them
// over standard SMTP, retrying on the configured backoff schedule until the
// row is delivered or goes to its failed terminal state. A row carrying a
// one-time code is retried only while the code remains usable: once the code
// is superseded or expired the row takes its cancelled terminal state instead
// of being delivered (ticket 05). It holds no other business rules; rate
// limiting and cooldowns live in the command layer.
type OutboxWorker struct {
	pool        *pgxpool.Pool
	client      *mail.Client
	retryDelays []time.Duration
}

// NewOutboxWorker builds a worker delivering through the given SMTP endpoint.
// The code path is identical for Mailpit and Resend (the provider): TLS and
// AUTH are negotiated from what the server advertises (see probeAuthSupport),
// so switching environments changes only the four SMTP deployment variables.
// An unreachable endpoint fails construction — and therefore startup —
// explicitly. retryDelays is the backoff schedule between delivery attempts;
// its length is the retry budget (see LoadRetryDelays).
func NewOutboxWorker(pool *pgxpool.Pool, cfg SMTPConfig, retryDelays []time.Duration) (*OutboxWorker, error) {
	if len(retryDelays) == 0 {
		return nil, errors.New("identity: outbox retry schedule is empty")
	}
	opts := []mail.Option{
		mail.WithPort(cfg.Port),
		mail.WithTLSPolicy(mail.TLSOpportunistic),
	}
	hasAuth, err := probeAuthSupport(cfg)
	if err != nil {
		return nil, fmt.Errorf("identity: probe SMTP endpoint %s:%d: %w", cfg.Host, cfg.Port, err)
	}
	if hasAuth {
		opts = append(opts,
			// SMTPAuthPlain (not the NoEnc variant) refuses to send credentials
			// over an unencrypted channel, so the Resend API key can never leak
			// to a server that advertises AUTH without STARTTLS.
			mail.WithSMTPAuth(mail.SMTPAuthPlain),
			mail.WithUsername(cfg.User),
			mail.WithPassword(cfg.Password),
		)
	}
	client, err := mail.NewClient(cfg.Host, opts...)
	if err != nil {
		return nil, fmt.Errorf("identity: build SMTP client: %w", err)
	}
	return &OutboxWorker{pool: pool, client: client, retryDelays: retryDelays}, nil
}

// probeAuthSupport asks the SMTP server whether it advertises AUTH, upgrading
// to STARTTLS first when offered (servers commonly advertise AUTH only on the
// encrypted channel). This is opportunistic auth, the counterpart of
// mail.TLSOpportunistic: go-mail hard-fails if auth is configured but not
// advertised, and Mailpit advertises none while Resend requires it.
func probeAuthSupport(cfg SMTPConfig) (bool, error) {
	netConn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", cfg.Host, cfg.Port), 10*time.Second)
	if err != nil {
		return false, err
	}
	_ = netConn.SetDeadline(time.Now().Add(10 * time.Second))
	conn, err := smtp.NewClient(netConn, cfg.Host)
	if err != nil {
		netConn.Close()
		return false, err
	}
	defer conn.Close()
	if ok, _ := conn.Extension("STARTTLS"); ok {
		if err := conn.StartTLS(&tls.Config{ServerName: cfg.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return false, fmt.Errorf("starttls: %w", err)
		}
	}
	hasAuth, _ := conn.Extension("AUTH")
	_ = conn.Quit()
	return hasAuth, nil
}

// Run polls until ctx is canceled, then returns nil. An in-flight delivery is
// canceled through ctx and its claim transaction rolls back, so shutdown never
// leaves a half-delivered row: the row is either still pending or delivered.
func (w *OutboxWorker) Run(ctx context.Context) error {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		// Drain the pending backlog, one row per transaction. On a delivery
		// error, back off to the next tick instead of hammering the endpoint.
		for {
			claimed, err := w.deliverNext(ctx)
			if ctx.Err() != nil {
				return nil
			}
			if err != nil {
				slog.Error("identity outbox delivery attempt failed", "error", err)
				break
			}
			if !claimed {
				break
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// deliverNext claims at most one due pending row and delivers it. The claim
// transaction stays open across the SMTP send: SKIP LOCKED keeps concurrent
// pollers off the row. A genuinely failed send commits the retry bookkeeping
// (next attempt scheduled, or failed terminal state once the budget is
// spent); a send canceled by shutdown rolls back untouched.
func (w *OutboxWorker) deliverNext(ctx context.Context) (claimed bool, err error) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("identity: begin outbox claim: %w", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	var (
		id                               string
		sender, recipient, subject, body string
		attempts                         int
		// deliverable is true for codeless rows and for rows whose code is
		// still usable; codeExpiresAt is nil for codeless rows. Both use the
		// database clock (selected alongside) so the retry horizon never
		// depends on the process clock.
		deliverable   bool
		codeExpiresAt *time.Time
		dbNow         time.Time
	)
	err = tx.QueryRow(ctx,
		`SELECT m.id, m.sender, m.recipient, m.subject, m.body, m.attempts,
		        c.id IS NULL OR (c.status = 'active' AND now() <= c.expires_at),
		        c.expires_at, now()
		 FROM identity.outbox_messages m
		 LEFT JOIN identity.verification_codes c ON c.id = m.verification_code_id
		 WHERE m.status = 'pending' AND m.next_attempt_at <= now()
		 ORDER BY m.next_attempt_at, m.created_at
		 LIMIT 1
		 FOR UPDATE OF m SKIP LOCKED`,
	).Scan(&id, &sender, &recipient, &subject, &body, &attempts, &deliverable, &codeExpiresAt, &dbNow)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("identity: claim outbox row: %w", err)
	}

	if !deliverable {
		// The carried code was superseded or has expired: the row takes its
		// cancelled terminal state without a delivery attempt, so the user
		// never receives an already-invalid code and no retry budget is spent.
		commitCtx := context.WithoutCancel(ctx)
		if _, err := tx.Exec(commitCtx,
			`UPDATE identity.outbox_messages SET status = 'cancelled' WHERE id = $1`, id,
		); err != nil {
			return true, fmt.Errorf("identity: cancel outbox row %s with invalidated code: %w", id, err)
		}
		if err := tx.Commit(commitCtx); err != nil {
			return true, fmt.Errorf("identity: commit outbox row %s cancellation: %w", id, err)
		}
		return true, nil
	}

	msg := mail.NewMsg()
	if err := msg.From(sender); err != nil {
		return true, fmt.Errorf("identity: outbox row %s sender: %w", id, err)
	}
	if err := msg.To(recipient); err != nil {
		return true, fmt.Errorf("identity: outbox row %s recipient: %w", id, err)
	}
	msg.Subject(subject)
	msg.SetBodyString(mail.TypeTextPlain, body)

	if err := w.client.DialAndSendWithContext(ctx, msg); err != nil {
		if ctx.Err() != nil {
			// Shutdown canceled the send: the deferred rollback returns the
			// row to pending untouched, so a restart never spends retry
			// budget on an attempt that never reached the wire.
			return true, fmt.Errorf("identity: deliver outbox row %s: %w", id, err)
		}
		return true, w.recordFailure(ctx, tx, id, attempts, codeExpiresAt, dbNow, err)
	}

	// The mail is on the wire: finish the bookkeeping even if shutdown began
	// mid-send, otherwise the row would roll back to pending and be delivered
	// a second time on restart.
	commitCtx := context.WithoutCancel(ctx)
	if _, err := tx.Exec(commitCtx,
		`UPDATE identity.outbox_messages SET status = 'delivered', attempts = $2 WHERE id = $1`, id, attempts+1,
	); err != nil {
		return true, fmt.Errorf("identity: mark outbox row %s delivered: %w", id, err)
	}
	if err := tx.Commit(commitCtx); err != nil {
		return true, fmt.Errorf("identity: commit outbox row %s: %w", id, err)
	}
	return true, nil
}

// recordFailure commits the bookkeeping for a genuinely failed attempt: the
// next retry is scheduled from the backoff table, or — once the retry budget
// (the schedule's length) is spent — the row takes its failed terminal state
// and stays in the table as the only operational visibility. For a
// code-carrying row whose next retry would land beyond the code's remaining
// validity, the retry horizon ends here instead: the row takes its cancelled
// terminal state immediately rather than waiting out a backoff that can never
// deliver a valid code. The mail never reached the wire, so committing cannot
// duplicate a delivery.
func (w *OutboxWorker) recordFailure(ctx context.Context, tx pgx.Tx, id string, attempts int, codeExpiresAt *time.Time, dbNow time.Time, sendErr error) error {
	commitCtx := context.WithoutCancel(ctx)
	attempts++
	switch {
	case attempts > len(w.retryDelays):
		if _, err := tx.Exec(commitCtx,
			`UPDATE identity.outbox_messages SET status = 'failed', attempts = $2 WHERE id = $1`, id, attempts,
		); err != nil {
			return fmt.Errorf("identity: mark outbox row %s failed: %w", id, err)
		}
	case codeExpiresAt != nil && dbNow.Add(w.retryDelays[attempts-1]).After(*codeExpiresAt):
		if _, err := tx.Exec(commitCtx,
			`UPDATE identity.outbox_messages SET status = 'cancelled', attempts = $2 WHERE id = $1`, id, attempts,
		); err != nil {
			return fmt.Errorf("identity: mark outbox row %s cancelled at the code's retry horizon: %w", id, err)
		}
	default:
		if _, err := tx.Exec(commitCtx,
			`UPDATE identity.outbox_messages
			 SET attempts = $2, next_attempt_at = now() + make_interval(secs => $3)
			 WHERE id = $1`, id, attempts, w.retryDelays[attempts-1].Seconds(),
		); err != nil {
			return fmt.Errorf("identity: schedule outbox row %s retry: %w", id, err)
		}
	}
	if err := tx.Commit(commitCtx); err != nil {
		return fmt.Errorf("identity: commit outbox row %s retry bookkeeping: %w", id, err)
	}
	return fmt.Errorf("identity: deliver outbox row %s: %w", id, sendErr)
}
