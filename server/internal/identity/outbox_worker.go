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

// OutboxWorker is a pure deliverer: it claims pending identity.outbox_messages
// rows with FOR UPDATE SKIP LOCKED and sends them over standard SMTP. It holds
// no business rules; rate limiting and cooldowns live in the command layer.
type OutboxWorker struct {
	pool   *pgxpool.Pool
	client *mail.Client
}

// NewOutboxWorker builds a worker delivering through the given SMTP endpoint.
// The code path is identical for Mailpit and Resend (the provider): TLS and
// AUTH are negotiated from what the server advertises (see probeAuthSupport),
// so switching environments changes only the four SMTP deployment variables.
// An unreachable endpoint fails construction — and therefore startup —
// explicitly.
func NewOutboxWorker(pool *pgxpool.Pool, cfg SMTPConfig) (*OutboxWorker, error) {
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
	return &OutboxWorker{pool: pool, client: client}, nil
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

// deliverNext claims at most one pending row and delivers it. The claim
// transaction stays open across the SMTP send: SKIP LOCKED keeps concurrent
// pollers off the row, and any failure rolls back to pending.
func (w *OutboxWorker) deliverNext(ctx context.Context) (claimed bool, err error) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("identity: begin outbox claim: %w", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	var (
		id                               string
		sender, recipient, subject, body string
	)
	err = tx.QueryRow(ctx,
		`SELECT id, sender, recipient, subject, body
		 FROM identity.outbox_messages
		 WHERE status = 'pending'
		 ORDER BY created_at
		 LIMIT 1
		 FOR UPDATE SKIP LOCKED`,
	).Scan(&id, &sender, &recipient, &subject, &body)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("identity: claim outbox row: %w", err)
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
		return true, fmt.Errorf("identity: deliver outbox row %s: %w", id, err)
	}

	// The mail is on the wire: finish the bookkeeping even if shutdown began
	// mid-send, otherwise the row would roll back to pending and be delivered
	// a second time on restart.
	commitCtx := context.WithoutCancel(ctx)
	if _, err := tx.Exec(commitCtx,
		`UPDATE identity.outbox_messages SET status = 'delivered' WHERE id = $1`, id,
	); err != nil {
		return true, fmt.Errorf("identity: mark outbox row %s delivered: %w", id, err)
	}
	if err := tx.Commit(commitCtx); err != nil {
		return true, fmt.Errorf("identity: commit outbox row %s: %w", id, err)
	}
	return true, nil
}
