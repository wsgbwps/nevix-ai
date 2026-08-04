// Composition root: constructs dependencies, starts the identity Outbox
// Worker and the HTTP server, and shuts both down gracefully. No business
// logic lives here.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	// Module configuration loads before the database pool opens, so a
	// misconfigured process fails before touching infrastructure.
	identityConfig, err := identity.LoadConfig(os.Getenv)
	if err != nil {
		return err
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return errors.New("missing required deployment variable: DATABASE_URL")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect to database: %w", err)
	}
	defer pool.Close()

	identityModule, err := identity.NewModule(pool, identityConfig)
	if err != nil {
		return err
	}
	workerDone := make(chan error, 1)
	go func() { workerDone <- identityModule.RunWorkers(ctx) }()

	bus := event.NewInMemoryBus()
	router := chi.NewRouter()
	router.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	identityModule.Register(router, bus)
	server := &http.Server{Addr: ":8080", Handler: router}
	serverDone := make(chan error, 1)
	go func() { serverDone <- server.ListenAndServe() }()
	log.Println("server listening on :8080")

	select {
	case <-ctx.Done():
	case err := <-serverDone:
		return fmt.Errorf("http server: %w", err)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("http server shutdown: %w", err)
	}
	if err := <-workerDone; err != nil {
		return fmt.Errorf("outbox worker shutdown: %w", err)
	}
	log.Println("shut down cleanly")
	return nil
}
