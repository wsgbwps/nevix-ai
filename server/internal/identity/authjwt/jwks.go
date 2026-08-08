// Package authjwt is the identity Module's private transport guard: Bearer
// JWT verification against a JWKS endpoint (ES256 over P-256, keys cached by
// kid and refreshed when an unknown kid appears). The rest of the Module sees
// it only as middleware plus a context accessor; verification failures are
// deliberately indistinguishable to callers and all map to one 401 envelope.
package authjwt

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/nevix-ai/server/internal/identity/command"
)

// cacheTTL bounds how long JWKS keys are trusted before a proactive refresh,
// so upstream key rotation takes effect without waiting for an unknown kid.
const cacheTTL = 10 * time.Minute

// ErrUnauthorized covers every verification failure: missing bearer, malformed
// token, wrong algorithm, unknown kid after refresh, bad signature, expired or
// subject-less claims. The transport contract maps it to 401 unauthorized and
// does not distinguish the reasons.
var ErrUnauthorized = errors.New("authjwt: unauthorized")

// Verifier verifies ES256 JWTs against the keys published at jwksURL.
type Verifier struct {
	jwksURL string
	client  *http.Client

	mu        sync.Mutex
	keys      map[string]*ecdsa.PublicKey
	fetchedAt time.Time
}

func NewVerifier(jwksURL string) *Verifier {
	return &Verifier{
		jwksURL: jwksURL,
		client:  &http.Client{Timeout: 5 * time.Second},
		keys:    map[string]*ecdsa.PublicKey{},
	}
}

type userIDKey struct{}

// Middleware guards a handler with Bearer JWT verification: a missing or
// invalid token yields the 401 error envelope; a valid one stores the token's
// subject (the authenticated user id) in the request context.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID, err := v.VerifyToken(r.Context(), bearerToken(r))
		if err != nil {
			command.WriteError(w, &command.Error{
				Status:  http.StatusUnauthorized,
				Code:    "unauthorized",
				Message: "The session is missing, invalid, or expired.",
			})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userIDKey{}, userID)))
	})
}

// UserID returns the authenticated user id the Middleware stored, or "".
func UserID(ctx context.Context) string {
	id, _ := ctx.Value(userIDKey{}).(string)
	return id
}

func bearerToken(r *http.Request) string {
	const prefix = "Bearer "
	value := r.Header.Get("Authorization")
	if !strings.HasPrefix(value, prefix) {
		return ""
	}
	return strings.TrimSpace(value[len(prefix):])
}

// VerifyToken verifies one ES256 JWT and returns its subject. Any failure is
// reported as ErrUnauthorized.
func (v *Verifier) VerifyToken(ctx context.Context, token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", ErrUnauthorized
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", ErrUnauthorized
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(headerJSON, &header); err != nil || header.Alg != "ES256" {
		return "", ErrUnauthorized
	}

	key, err := v.key(ctx, header.Kid)
	if err != nil {
		return "", ErrUnauthorized
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != 64 {
		return "", ErrUnauthorized
	}
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])
	signingInput := parts[0] + "." + parts[1]
	digest := sha256.Sum256([]byte(signingInput))
	if !ecdsa.Verify(key, digest[:], r, s) {
		return "", ErrUnauthorized
	}

	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", ErrUnauthorized
	}
	var claims struct {
		Sub string  `json:"sub"`
		Exp float64 `json:"exp"`
	}
	if err := json.Unmarshal(payloadJSON, &claims); err != nil {
		return "", ErrUnauthorized
	}
	if claims.Sub == "" || claims.Exp == 0 || time.Now().Unix() >= int64(claims.Exp) {
		return "", ErrUnauthorized
	}
	return claims.Sub, nil
}

// key resolves a kid to a cached public key, refreshing the JWKS once when
// the kid is unknown or the cache has aged past cacheTTL.
func (v *Verifier) key(ctx context.Context, kid string) (*ecdsa.PublicKey, error) {
	if kid == "" {
		return nil, ErrUnauthorized
	}
	v.mu.Lock()
	if key, ok := v.keys[kid]; ok && time.Since(v.fetchedAt) < cacheTTL {
		v.mu.Unlock()
		return key, nil
	}
	v.mu.Unlock()

	if err := v.refresh(ctx); err != nil {
		return nil, err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if key, ok := v.keys[kid]; ok {
		return key, nil
	}
	return nil, ErrUnauthorized
}

// refresh replaces the cache with the latest JWKS contents. Only ES256-usable
// P-256 keys are kept; everything else in the set is ignored.
func (v *Verifier) refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return err
	}
	resp, err := v.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("authjwt: jwks endpoint returned %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	var document struct {
		Keys []struct {
			Kty string `json:"kty"`
			Crv string `json:"crv"`
			Kid string `json:"kid"`
			X   string `json:"x"`
			Y   string `json:"y"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return err
	}

	keys := map[string]*ecdsa.PublicKey{}
	for _, entry := range document.Keys {
		if entry.Kty != "EC" || entry.Crv != "P-256" || entry.Kid == "" {
			continue
		}
		x, errX := base64.RawURLEncoding.DecodeString(entry.X)
		y, errY := base64.RawURLEncoding.DecodeString(entry.Y)
		if errX != nil || errY != nil {
			continue
		}
		keys[entry.Kid] = &ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(x),
			Y:     new(big.Int).SetBytes(y),
		}
	}

	v.mu.Lock()
	v.keys = keys
	v.fetchedAt = time.Now()
	v.mu.Unlock()
	return nil
}
