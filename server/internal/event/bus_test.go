package event_test

import (
	"reflect"
	"testing"

	"github.com/nevix-ai/server/internal/event"
)

func TestInMemoryBusDeliversToSubscribersOfTheEventType(t *testing.T) {
	bus := event.NewInMemoryBus()
	var got, other []event.Event
	bus.Subscribe("thing.happened", func(e event.Event) { got = append(got, e) })
	bus.Subscribe("other.happened", func(e event.Event) { other = append(other, e) })

	bus.Publish(event.Event{Type: "thing.happened", Payload: 42})

	if len(got) != 1 || got[0].Payload != 42 {
		t.Fatalf("subscriber received %v, want one event with payload 42", got)
	}
	if len(other) != 0 {
		t.Fatalf("unrelated subscriber received %v, want nothing", other)
	}
}

func TestSessionRevokedCarriesOnlyTheNonSensitiveSessionIdentity(t *testing.T) {
	payload := event.SessionRevoked{SessionID: "session-1"}
	shape := reflect.TypeOf(payload)
	if shape.NumField() != 1 || shape.Field(0).Name != "SessionID" || shape.Field(0).Type.Kind() != reflect.String {
		t.Fatalf("session revocation payload = %v, want only string SessionID", shape)
	}
	if event.SessionRevokedType != "identity.session-revoked" {
		t.Fatalf("session revocation event type = %q, want stable identity.session-revoked", event.SessionRevokedType)
	}
}
