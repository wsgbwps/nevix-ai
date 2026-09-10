//go:build !e2e

package main

import (
	"github.com/nevix-ai/server/internal/creation"
	"github.com/nevix-ai/server/internal/identity"
)

func creationDependencies(identityModule *identity.Module) creation.Deps {
	return creation.Deps{
		SessionAuthenticator: identityModule.SessionAuthenticator(),
		ReauthVerifier:       identityModule.ReauthProofs(),
	}
}
