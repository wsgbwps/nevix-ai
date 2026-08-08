// The Module's trusted-command route table. Public is zero-value safe: a
// route that does not declare Public: true is mounted behind the Bearer
// guard, and every path's OPTIONS preflight twin and Allow-Methods value
// derive from this single table (see command.Mount and command.AllowMethods).
package identity

import (
	"net/http"

	"github.com/nevix-ai/server/internal/identity/command"
)

func (m *Module) routes() []command.Route {
	return []command.Route{
		{Method: http.MethodPost, Path: "/identity/verification-codes", Public: true, Handler: m.issuer.ServeHTTP},
		{Method: http.MethodPost, Path: "/identity/organizations", Handler: m.orgs.ServeHTTP},
	}
}
