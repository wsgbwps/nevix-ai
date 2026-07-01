package event

type Event struct {
	Type    string
	Payload any
}

type Bus interface {
	Publish(event Event)
	Subscribe(eventType string, handler func(Event))
}
