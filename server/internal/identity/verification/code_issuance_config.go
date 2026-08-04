package verification

import "fmt"

// CodeIssuanceConfig is the deployment configuration of the verification code
// issuance command. HashKey peppers the HMAC that turns a six-digit code into
// its stored hash: a database leak must not allow offline brute-forcing the
// one-million code space. From is the sender of the code-carrying email; the
// sending domain is verified at deploy time, so it is configuration, not
// code.
type CodeIssuanceConfig struct {
	HashKey []byte
	From    string
}

// LoadCodeIssuanceConfig reads VERIFICATION_CODE_HASH_KEY and SMTP_FROM via
// getenv. A missing variable is an error naming that variable, so a
// misconfigured process fails explicitly at startup, like the SMTP contract.
func LoadCodeIssuanceConfig(getenv func(string) string) (CodeIssuanceConfig, error) {
	var missing []string
	for _, key := range []string{"VERIFICATION_CODE_HASH_KEY", "SMTP_FROM"} {
		if getenv(key) == "" {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		return CodeIssuanceConfig{}, fmt.Errorf("identity: missing required code issuance deployment variables: %v", missing)
	}
	return CodeIssuanceConfig{
		HashKey: []byte(getenv("VERIFICATION_CODE_HASH_KEY")),
		From:    getenv("SMTP_FROM"),
	}, nil
}
