package identity_test

import (
	"strings"
	"testing"

	"github.com/nevix-ai/server/internal/identity"
)

func fakeGetenv(vars map[string]string) func(string) string {
	return func(key string) string { return vars[key] }
}

func validSMTPEnv() map[string]string {
	return map[string]string{
		"SMTP_HOST":     "smtp.resend.com",
		"SMTP_PORT":     "587",
		"SMTP_USER":     "resend",
		"SMTP_PASSWORD": "re_secret",
	}
}

func TestLoadSMTPConfigReadsAllFourDeploymentVariables(t *testing.T) {
	cfg, err := identity.LoadSMTPConfig(fakeGetenv(validSMTPEnv()))
	if err != nil {
		t.Fatalf("LoadSMTPConfig with all variables set: %v", err)
	}
	if cfg.Host != "smtp.resend.com" || cfg.Port != 587 || cfg.User != "resend" || cfg.Password != "re_secret" {
		t.Fatalf("LoadSMTPConfig returned %+v, want values from environment", cfg)
	}
}

func TestLoadSMTPConfigFailsNamingEachMissingVariable(t *testing.T) {
	for _, missing := range []string{"SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"} {
		t.Run(missing, func(t *testing.T) {
			vars := validSMTPEnv()
			delete(vars, missing)
			_, err := identity.LoadSMTPConfig(fakeGetenv(vars))
			if err == nil {
				t.Fatalf("LoadSMTPConfig succeeded with %s unset, want error", missing)
			}
			if !strings.Contains(err.Error(), missing) {
				t.Fatalf("error %q does not name the missing variable %s", err, missing)
			}
		})
	}
}

func TestLoadSMTPConfigRejectsNonNumericPort(t *testing.T) {
	vars := validSMTPEnv()
	vars["SMTP_PORT"] = "not-a-port"
	_, err := identity.LoadSMTPConfig(fakeGetenv(vars))
	if err == nil || !strings.Contains(err.Error(), "SMTP_PORT") {
		t.Fatalf("LoadSMTPConfig with invalid port returned %v, want error naming SMTP_PORT", err)
	}
}
