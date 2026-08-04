package verification_test

import (
	"strings"
	"testing"

	"github.com/nevix-ai/server/internal/identity/verification"
)

func fakeGetenv(vars map[string]string) func(string) string {
	return func(key string) string { return vars[key] }
}

func validCodeIssuanceEnv() map[string]string {
	return map[string]string{
		"VERIFICATION_CODE_HASH_KEY": "test-hash-key",
		"SMTP_FROM":                  "identity@nevix.test",
	}
}

func TestLoadCodeIssuanceConfigReadsDeploymentVariables(t *testing.T) {
	cfg, err := verification.LoadCodeIssuanceConfig(fakeGetenv(validCodeIssuanceEnv()))
	if err != nil {
		t.Fatalf("LoadCodeIssuanceConfig with all variables set: %v", err)
	}
	if string(cfg.HashKey) != "test-hash-key" || cfg.From != "identity@nevix.test" {
		t.Fatalf("LoadCodeIssuanceConfig returned %+v, want values from environment", cfg)
	}
}

func TestLoadCodeIssuanceConfigFailsNamingEachMissingVariable(t *testing.T) {
	for _, missing := range []string{"VERIFICATION_CODE_HASH_KEY", "SMTP_FROM"} {
		t.Run(missing, func(t *testing.T) {
			vars := validCodeIssuanceEnv()
			delete(vars, missing)
			_, err := verification.LoadCodeIssuanceConfig(fakeGetenv(vars))
			if err == nil {
				t.Fatalf("LoadCodeIssuanceConfig succeeded with %s unset, want error", missing)
			}
			if !strings.Contains(err.Error(), missing) {
				t.Fatalf("error %q does not name the missing variable %s", err, missing)
			}
		})
	}
}
