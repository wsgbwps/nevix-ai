package event_test

import (
	"testing"

	"github.com/nevix-ai/server/pkg/event"
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
