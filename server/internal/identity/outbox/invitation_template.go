package outbox

import (
	"bytes"
	_ "embed"
	"fmt"
	"text/template"
)

const invitationSubject = "Nevix 邀请码 / Nevix invitation code"

//go:embed templates/invitation.txt
var invitationTemplateText string

var invitationTemplate = template.Must(template.New("invitation").Parse(invitationTemplateText))

// InvitationTemplateData contains the values rendered into the bilingual,
// plain-text Invitation email before its Outbox row commits.
type InvitationTemplateData struct {
	OrganizationName string
	Code             string
}

// RenderInvitation produces the final mail payload at command-write time. The
// Outbox Worker only delivers this completed message and never applies language
// or business rules.
func RenderInvitation(data InvitationTemplateData) (subject, body string, err error) {
	var rendered bytes.Buffer
	if err := invitationTemplate.Execute(&rendered, data); err != nil {
		return "", "", fmt.Errorf("identity outbox: render invitation template: %w", err)
	}
	return invitationSubject, rendered.String(), nil
}
