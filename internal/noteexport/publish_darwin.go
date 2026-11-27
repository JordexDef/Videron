package noteexport

import (
	"os"

	"golang.org/x/sys/unix"
)

func publish(root *os.Root, from, to string) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	fd := int(dir.Fd())
	return unix.RenameatxNp(fd, from, fd, to, unix.RENAME_EXCL)
}
