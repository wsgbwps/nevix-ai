package outbox

import (
	"bytes"
	_ "embed"
	"fmt"
	"text/template"
)

const (
	adminPromotedSubject = "Nevix 管理员权限提升通知 / Nevix admin promotion notice"
	adminDemotedSubject  = "Nevix 管理员权限降级通知 / Nevix admin demotion notice"
	adminRemovedSubject  = "Nevix 管理员移除通知 / Nevix admin removal notice"
)

//go:embed templates/admin_promoted.txt
var adminPromotedTemplateText string

//go:embed templates/admin_demoted.txt
var adminDemotedTemplateText string

//go:embed templates/admin_removed.txt
var adminRemovedTemplateText string

var (
	adminPromotedTemplate = template.Must(template.New("admin_promoted").Parse(adminPromotedTemplateText))
	adminDemotedTemplate  = template.Must(template.New("admin_demoted").Parse(adminDemotedTemplateText))
	adminRemovedTemplate  = template.Must(template.New("admin_removed").Parse(adminRemovedTemplateText))
)

// AdminRoleTemplateData contains the immutable event snapshots rendered into
// each codeless Admin lifecycle email before its Outbox rows commit.
type AdminRoleTemplateData struct {
	OrganizationName string
	ActorName        string
	AffectedName     string
	RecipientName    string
}

// RenderAdminPromoted produces the bilingual Admin-promotion payload.
func RenderAdminPromoted(data AdminRoleTemplateData) (subject, body string, err error) {
	return renderAdminRoleTemplate(adminPromotedTemplate, adminPromotedSubject, data)
}

// RenderAdminDemoted produces the bilingual Admin-demotion payload.
func RenderAdminDemoted(data AdminRoleTemplateData) (subject, body string, err error) {
	return renderAdminRoleTemplate(adminDemotedTemplate, adminDemotedSubject, data)
}

// RenderAdminRemoved produces the bilingual Admin-removal payload.
func RenderAdminRemoved(data AdminRoleTemplateData) (subject, body string, err error) {
	return renderAdminRoleTemplate(adminRemovedTemplate, adminRemovedSubject, data)
}

func renderAdminRoleTemplate(notification *template.Template, subject string, data AdminRoleTemplateData) (string, string, error) {
	var rendered bytes.Buffer
	if err := notification.Execute(&rendered, data); err != nil {
		return "", "", fmt.Errorf("identity outbox: render %s template: %w", notification.Name(), err)
	}
	return subject, rendered.String(), nil
}
