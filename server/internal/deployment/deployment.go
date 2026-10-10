// Package deployment implements the shipped operator CLI, never the running Server.
package deployment

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/nevix-ai/server/internal/release"
)

// Run is the operator command boundary. The caller supplies its compiled publisher anchor.
func Run(args []string, publicKey string) error {
	if len(args) > 0 && (args[0] == "upgrade" || args[0] == "recover-upgrade") {
		return upgradeCommand(args, publicKey)
	}
	if len(args) > 0 && (args[0] == "backup" || args[0] == "verify-backup" || args[0] == "restore") {
		return backupCommand(args, publicKey)
	}
	if len(args) > 0 && args[0] == "pack" {
		return pack(args[1:])
	}
	if len(args) == 0 {
		return errors.New("usage: nevix-deploy verify|import|install|backup|verify-backup|restore|upgrade|recover-upgrade (see operator manuals)")
	}
	if args[0] != "verify" && args[0] != "import" && args[0] != "install" {
		return errors.New("unknown command")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	manifestPath := flags.String("manifest", "", "signed release envelope")
	bundlePath := flags.String("bundle", "", "complete release tar.gz")
	directory := flags.String("directory", "", "instance directory")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 || *manifestPath == "" || *bundlePath == "" || (args[0] != "verify" && *directory == "") {
		return errors.New("manifest, bundle and installation directory required")
	}
	f, err := os.Open(*manifestPath)
	if err != nil {
		return err
	}
	defer f.Close()
	envelope, err := io.ReadAll(io.LimitReader(f, 64*1024+1))
	if err != nil {
		return err
	}
	manifest, err := release.Verify(envelope, publicKey, "linux", "amd64")
	if err != nil {
		return fmt.Errorf("verify signed release: %w", err)
	}
	return verifyAndImport(args[0], *bundlePath, *directory, envelope, manifest)
}
