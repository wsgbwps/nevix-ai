package event

import "sync"

type Event struct {
	Type    string
	Payload any
}

type Bus interface {
	Publish(event Event)
	Subscribe(eventType string, handler func(Event))
}

// InMemoryBus is the single-process Bus the composition root builds: Publish
// dispatches synchronously to every subscriber of the event type.
type InMemoryBus struct {
	mu       sync.RWMutex
	handlers map[string][]func(Event)
}

func NewInMemoryBus() *InMemoryBus {
	return &InMemoryBus{handlers: make(map[string][]func(Event))}
}

func (b *InMemoryBus) Publish(event Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, handler := range b.handlers[event.Type] {
		handler(event)
	}
}

func (b *InMemoryBus) Subscribe(eventType string, handler func(Event)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.handlers[eventType] = append(b.handlers[eventType], handler)
}
