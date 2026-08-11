package outbox

import (
	"bytes"
	_ "embed"
	"fmt"
	"text/template"
)

const memberRemovedSubject = "Nevix 成员移除通知 / Nevix member removal notice"

//go:embed templates/member_removed.txt
var memberRemovedTemplateText string

var memberRemovedTemplate = template.Must(template.New("member_removed").Parse(memberRemovedTemplateText))

// MemberRemovedTemplateData contains the immutable event snapshots rendered
// into the codeless Member-removal email before its Outbox row commits.
type MemberRemovedTemplateData struct {
	OrganizationName string
	ActorName        string
	AffectedName     string
}

// RenderMemberRemoved produces the final bilingual plain-text message. The
// Outbox Worker only delivers its completed payload.
func RenderMemberRemoved(data MemberRemovedTemplateData) (subject, body string, err error) {
	var rendered bytes.Buffer
	if err := memberRemovedTemplate.Execute(&rendered, data); err != nil {
		return "", "", fmt.Errorf("identity outbox: render member removal template: %w", err)
	}
	return memberRemovedSubject, rendered.String(), nil
}
