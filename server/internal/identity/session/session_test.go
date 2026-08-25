// The closed revocation-target constructors' refusal contract: an absent
// identity is not a revocation target. Pure construction behavior — no
// database involvement, so it runs in the plain suite like the command
// request-shape tests.
package session

import "testing"

// Each constructor refuses the targets the package documents as
// unconstructible: a current without a session identity, an others without
// its user or its surviving current session, and an all without its user —
// an empty identity would otherwise widen or hollow the disposition (spec
// #138/#141).
func TestRevocationTargetConstructorsRefuseAbsentIdentities(t *testing.T) {
	for name, construct := range map[string]func() (RevocationTarget, error){
		"current without a session identity": func() (RevocationTarget, error) { return Current("") },
		"others without a user":              func() (RevocationTarget, error) { return Others("", "session") },
		"others without its current session": func() (RevocationTarget, error) { return Others("user", "") },
		"all without a user":                 func() (RevocationTarget, error) { return All("") },
	} {
		target, err := construct()
		if err == nil || target != nil {
			t.Fatalf("%s: constructed target=%v err=%v; want refusal", name, target, err)
		}
	}

	// The three valid forms still construct.
	for name, construct := range map[string]func() (RevocationTarget, error){
		"current": func() (RevocationTarget, error) { return Current("session-identity") },
		"others":  func() (RevocationTarget, error) { return Others("user-identity", "session-identity") },
		"all":     func() (RevocationTarget, error) { return All("user-identity") },
	} {
		if target, err := construct(); err != nil || target == nil {
			t.Fatalf("%s: target=%v err=%v; want the valid form to construct", name, target, err)
		}
	}
}
