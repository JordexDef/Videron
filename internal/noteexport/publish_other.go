//go:build !windows && !linux && !darwin

package noteexport

import "os"

func publish(*os.Root, string, string) error { return ErrWrite }
