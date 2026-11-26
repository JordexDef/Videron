//go:build !windows

package acp

import (
	"os/exec"
	"syscall"
)

func acpExecutable(path string, args []string) (string, []string, error) { return path, args, nil }

func acpConfigureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func acpOwnProcess(cmd *exec.Cmd) (func(), error) {
	return func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }, nil
}
