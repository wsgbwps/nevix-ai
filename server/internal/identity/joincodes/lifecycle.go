// The join-code lifecycle commands (issue #120): issue a code, list the
// active codes with their plaintext, revoke one. Each write is one Write
// Transaction Module run whose audit row commits with the mutation.
package joincodes

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/identity/audit"
)

// maxActiveJoinCodes caps the concurrently active set (ADR-0015): codes are
// reusable, so three cover every onboarding wave; revoking frees a slot.
const maxActiveJoinCodes = 3

// joinCodeLength is the generated code's length: 8 Crockford base32
// characters, ~1.07e12 equally likely codes — far beyond any guessing budget
// an on-prem deployment faces, while staying readable over a phone call.
const joinCodeLength = 8

// crockfordAlphabet is Crockford base32 without I, L, O, and U: the digits
// and letters that survive being read aloud without ambiguity. 32 symbols
// divide 256 exactly, so one random byte selects one symbol without bias.
const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// generateJoinCode returns one uniformly random code string.
func generateJoinCode() (string, error) {
	raw := make([]byte, joinCodeLength)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("joincodes: read randomness: %w", err)
	}
	code := make([]byte, joinCodeLength)
	for i, b := range raw {
		code[i] = crockfordAlphabet[int(b)%len(crockfordAlphabet)]
	}
	return string(code), nil
}

// Create issues one join code. The active cap is enforced inside the write
// transaction: the create locks every active row FOR UPDATE, so concurrent
// creates serialize and the second one re-reads the count including the first
// one's committed row (the same pattern the last-active-admin protection
// uses). The plaintext is returned once here and stays visible in the list.
func (s *Service) Create(ctx context.Context, principal authz.Principal, req CreateRequest) (CreateResponse, error) {
	label := strings.TrimSpace(req.Label)

	var created JoinCodeEntry
	err := s.runner.Run(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT id FROM public.join_codes WHERE revoked_at IS NULL FOR UPDATE`)
		if err != nil {
			return fmt.Errorf("joincodes: lock active codes: %w", err)
		}
		active := 0
		for rows.Next() {
			active++
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("joincodes: read active codes: %w", err)
		}
		rows.Close()
		if active >= maxActiveJoinCodes {
			return errTooManyActiveJoinCodes
		}

		// A collision with a live code's unique constraint is a ~2^-40 event
		// per pair; retrying with fresh randomness settles it immediately and
		// fails loudly as an unmapped error if the store is truly exhausted.
		for attempt := 0; ; attempt++ {
			code, err := generateJoinCode()
			if err != nil {
				return err
			}
			err = tx.QueryRow(ctx,
				`INSERT INTO public.join_codes (code, label, created_by)
				 VALUES ($1, $2, $3)
				 RETURNING id, code, label, created_by, created_at`,
				code, label, principal.UserID,
			).Scan(&created.ID, &created.Code, &created.Label, &created.CreatedBy, &created.CreatedAt)
			if isUniqueViolation(err, "join_codes_code_key") && attempt < 2 {
				continue
			}
			if err != nil {
				return fmt.Errorf("joincodes: insert join code: %w", err)
			}
			break
		}

		return writeAudit(ctx, tx, principal.UserID, audit.JoinCodeCreated,
			map[string]string{"join_code_id": created.ID, "label": label})
	})
	if err != nil {
		return CreateResponse{}, err
	}
	return CreateResponse{JoinCode: created}, nil
}

// List returns the active codes newest first: the plaintext, the note, and
// the issuing admin, everything the settings card shows.
func (s *Service) List(ctx context.Context) (ListResponse, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, code, label, created_by, created_at
		 FROM public.join_codes WHERE revoked_at IS NULL
		 ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return ListResponse{}, fmt.Errorf("joincodes: list active codes: %w", err)
	}
	defer rows.Close()

	codes := []JoinCodeEntry{}
	for rows.Next() {
		var entry JoinCodeEntry
		if err := rows.Scan(&entry.ID, &entry.Code, &entry.Label, &entry.CreatedBy, &entry.CreatedAt); err != nil {
			return ListResponse{}, fmt.Errorf("joincodes: scan active code: %w", err)
		}
		codes = append(codes, entry)
	}
	if err := rows.Err(); err != nil {
		return ListResponse{}, fmt.Errorf("joincodes: read active codes: %w", err)
	}
	return ListResponse{JoinCodes: codes}, nil
}

// Revoke ends one active code. An unknown, already-revoked, or malformed id
// is the same 404: revocation is idempotent-terminal, and the revoked row
// stays as the record the audit trail corroborates.
func (s *Service) Revoke(ctx context.Context, principal authz.Principal, joinCodeID string) (RevokeResponse, error) {
	id, err := parseJoinCodeID(joinCodeID)
	if err != nil {
		return RevokeResponse{}, errJoinCodeNotFound
	}

	err = s.runner.Run(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`UPDATE public.join_codes SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, id)
		if err != nil {
			return fmt.Errorf("joincodes: revoke join code: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return errJoinCodeNotFound
		}
		return writeAudit(ctx, tx, principal.UserID, audit.JoinCodeRevoked,
			map[string]string{"join_code_id": joinCodeID})
	})
	if err != nil {
		return RevokeResponse{}, err
	}
	return RevokeResponse{Status: "revoked"}, nil
}

// parseJoinCodeID validates a path parameter as a UUID; a malformed id is the
// same not-found answer as an absent one and never reaches the database.
func parseJoinCodeID(raw string) (pgtype.UUID, error) {
	var id pgtype.UUID
	if err := id.Scan(raw); err != nil {
		return pgtype.UUID{}, err
	}
	return id, nil
}

// writeAudit snapshots the acting admin inside the transaction and appends
// the join-code audit row. The target is nil — a join code is not a User —
// and the row names the code by id, with the label as issued context.
func writeAudit(ctx context.Context, tx pgx.Tx, actorUserID string, action audit.Action, metadata map[string]string) error {
	actor, err := audit.SnapshotSubject(ctx, tx, actorUserID)
	if err != nil {
		return err
	}
	return audit.Write(ctx, tx, audit.Entry{Actor: actor, Action: action, Metadata: metadata})
}

// isUniqueViolation reports whether err is the named unique constraint
// firing; the join_codes_code_key violation is the collision retry case.
func isUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}
