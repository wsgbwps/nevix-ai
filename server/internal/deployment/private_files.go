package deployment

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func privateInstanceDirectory(directory string) error {
	st, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 || st.Mode().Perm()&0077 != 0 || !ok || int(owner.Uid) != os.Geteuid() {
		return errors.New("instance directory must be a private owned regular directory (0700)")
	}
	return nil
}
func validatePrivateDestination(directory, name string) error {
	if err := privateInstanceDirectory(directory); err != nil {
		return err
	}
	st, err := os.Lstat(filepath.Join(directory, name))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 {
		return errors.New("destination must be a private regular file (0600), never a symlink")
	}
	return nil
}
func replacePrivateFile(directory, name string, b []byte) error {
	if err := validatePrivateDestination(directory, name); err != nil {
		return err
	}
	f, err := os.CreateTemp(directory, ".private-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = validatePrivateDestination(directory, name); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), filepath.Join(directory, name)); err != nil {
		return err
	}
	st, err := os.Lstat(filepath.Join(directory, name))
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 {
		return errors.New("private file replacement permissions invalid")
	}
	d, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
