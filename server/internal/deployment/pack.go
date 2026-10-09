package deployment

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"

	"github.com/nevix-ai/server/internal/release"
)

// pack is vendor build tooling; it never signs and is not needed by customer hosts.
func pack(args []string) error {
	flags := flag.NewFlagSet("pack", flag.ContinueOnError)
	inputs := flags.String("inputs", "", "tracked build export")
	version := flags.String("version", "", "stable Server version")
	desktop := flags.String("min-desktop-version", "", "minimum Desktop version")
	source := flags.String("min-server-version", "", "minimum source Server version")
	commit := flags.String("source-commit", "", "source commit")
	output := flags.String("output", "", "output tar.gz")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *inputs == "" || *output == "" || !commitPattern.MatchString(*commit) {
		return errors.New("pack requires tracked inputs, output and source commit")
	}
	for _, v := range []string{*version, *desktop, *source} {
		if _, err := release.CompareVersions(v, "0.0.0"); err != nil {
			return err
		}
	}
	archive, err := readImageArchive(filepath.Join(*inputs, "images.tar"))
	if err != nil {
		return err
	}
	inv := inventory{Format: "nevix-runtime-v1", Version: *version, MinDesktopVersion: *desktop, MinServerVersion: *source, SourceCommit: *commit, PostgresMajor: 17}
	provenance := map[string][]string{"server": {"git:" + *commit + ":deploy/Dockerfile.server", goSource, alpineSource}, "cert-init": {"git:" + *commit + ":deploy/cert-init/Dockerfile", alpineSource}, "postgres": {postgresSource}, "nginx": {nginxSource}}
	for _, service := range []string{"server", "cert-init", "postgres", "nginx"} {
		im, err := archive.imageFor("nevix-bundle-" + service + ":" + *version)
		if err != nil {
			return err
		}
		im.Service = service
		im.Provenance = provenance[service]
		inv.Images = append(inv.Images, im)
	}
	inventoryBytes, err := json.Marshal(inv)
	if err != nil {
		return err
	}
	out, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	success := false
	defer func() {
		out.Close()
		if !success {
			os.Remove(*output)
		}
	}()
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)
	paths := map[string]string{"compose.template.yaml": "deploy/runtime-compose.template.yaml", ".env.example": "deploy/.env.example", "nginx/nginx.conf": "deploy/nginx/nginx.conf", "postgres/init-identity-app.sh": "deploy/postgres/init-identity-app.sh", "tools/nevix-deploy": "tools/nevix-deploy", "README.md": "deploy/offline-install.md", "images.tar": "images.tar"}
	for _, name := range []string{"bundle.json", "compose.template.yaml", ".env.example", "nginx/nginx.conf", "postgres/init-identity-app.sh", "tools/nevix-deploy", "README.md", "images.tar"} {
		var size int64
		var f *os.File
		if name == "bundle.json" {
			size = int64(len(inventoryBytes))
		} else {
			f, err = os.Open(filepath.Join(*inputs, paths[name]))
			if err != nil {
				return err
			}
			st, err := f.Stat()
			if err != nil {
				f.Close()
				return err
			}
			if !st.Mode().IsRegular() {
				f.Close()
				return errors.New("pack input must be a regular tracked file")
			}
			size = st.Size()
		}
		if size > bundleFiles[name] {
			if f != nil {
				f.Close()
			}
			return errors.New("pack input exceeds bundle limit")
		}
		mode := int64(0600)
		if name == "tools/nevix-deploy" {
			mode = 0700
		}
		if name == "postgres/init-identity-app.sh" {
			mode = 0755
		}
		if err = tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: size, Typeflag: tar.TypeReg}); err != nil {
			if f != nil {
				f.Close()
			}
			return err
		}
		if f == nil {
			_, err = tw.Write(inventoryBytes)
		} else {
			_, err = io.Copy(tw, f)
			f.Close()
		}
		if err != nil {
			return err
		}
	}
	if err = tw.Close(); err != nil {
		return err
	}
	if err = gz.Close(); err != nil {
		return err
	}
	if err = out.Close(); err != nil {
		return err
	}
	success = true
	return nil
}
