//go:build !windows

package desktop

import (
	"os/exec"
	"runtime"
	"strings"
)

func showFolder(path string) error {
	// A trailing separator requires a directory at lookup time. Absolute paths
	// are passed as one argument, including spaces and shell metacharacters.
	if !strings.HasSuffix(path, "/") {
		path += "/"
	}
	if runtime.GOOS == "darwin" {
		return exec.Command("/usr/bin/open", "-a", "Finder", path).Run()
	}
	return exec.Command("xdg-open", path).Run()
}
