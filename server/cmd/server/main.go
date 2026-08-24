// Composition root: applies schema migrations with the DDL credential, then
// constructs dependencies, starts the identity maintenance worker and the
// HTTP server, and shuts both down gracefully. No business logic lives here.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity"
	"github.com/nevix-ai/server/internal/migration"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	// Module configuration loads before the database pool opens, so a
	// misconfigured process fails before touching infrastructure.
	identityConfig, err := identity.LoadConfig(os.LookupEnv)
	if err != nil {
		return err
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return errors.New("missing required deployment variable: DATABASE_URL")
	}
	// The migration credential owns DDL; the application pool (identity_app)
	// never does (ADR-0014). Startup runs migrations automatically before the
	// module exists (ADR-0013).
	migrationDatabaseURL := os.Getenv("MIGRATION_DATABASE_URL")
	if migrationDatabaseURL == "" {
		return errors.New("missing required deployment variable: MIGRATION_DATABASE_URL")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	applied, err := migration.Apply(ctx, migrationDatabaseURL)
	if err != nil {
		return err
	}
	for _, m := range applied {
		log.Printf("migration applied: %s", strings.TrimSuffix(filepath.Base(m.Source.Path), filepath.Ext(m.Source.Path)))
	}
	if len(applied) == 0 {
		log.Println("migrations current; nothing to apply")
	}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect to database: %w", err)
	}
	defer pool.Close()

	identityModule, err := identity.NewModule(ctx, pool, identityConfig)
	if err != nil {
		return err
	}
	workerDone := make(chan error, 1)
	go func() { workerDone <- identityModule.RunWorkers(ctx) }()

	bus := event.NewInMemoryBus()
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.Logger)
	router.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	router.Group(func(r chi.Router) {
		identityModule.Register(r, bus)
	})
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
		return fmt.Errorf("identity worker shutdown: %w", err)
	}
	log.Println("shut down cleanly")
	return nil
}
