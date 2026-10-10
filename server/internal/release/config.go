package release

import (
	"errors"
	"fmt"
	"strings"
)

// Config owns Release's browser origins; release identity and trust remain compiled.
type Config struct{ CORSAllowedOrigins []string }

// LoadConfig fails before infrastructure opens, including invalid compiled identity.
func LoadConfig(lookup func(string) (string, bool)) (Config, error) {
	if err := validateBuildIdentity(); err != nil {
		return Config{}, fmt.Errorf("release: invalid compiled identity: %w", err)
	}
	raw, _ := lookup("CORS_ALLOWED_ORIGINS")
	if strings.TrimSpace(raw) == "" {
		return Config{}, errors.New("release: missing required deployment variable: CORS_ALLOWED_ORIGINS")
	}
	origins := []string{}
	for _, entry := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(entry)
		if origin == "" || origin == "*" {
			return Config{}, errors.New("release: CORS_ALLOWED_ORIGINS requires exact nonempty origins")
		}
		origins = append(origins, origin)
	}
	return Config{CORSAllowedOrigins: origins}, nil
}
