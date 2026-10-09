package main

import (
	"fmt"
	"os"

	"github.com/nevix-ai/server/internal/deployment"
	"github.com/nevix-ai/server/internal/release"
)

func main() {
	if err := deployment.Run(os.Args[1:], release.PublicKeyPEM); err != nil {
		fmt.Fprintln(os.Stderr, "nevix-deploy:", err)
		os.Exit(1)
	}
}
