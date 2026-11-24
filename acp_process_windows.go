//go:build windows

package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// npm's standard Windows launcher points to a Node entry point. Run that
// script directly so that user arguments never pass through cmd.exe expansion.
var acpNodeShim = regexp.MustCompile(`(?im)"%_prog%"[ \t]+"%dp0%[\\/](node_modules[\\/][^"%\r\n]+)"[ \t]+%\*[ \t]*\r?$`)

func acpExecutable(path string, args []string) (string, []string, error) {
	ext := strings.ToLower(filepath.Ext(path))
	if ext == ".exe" || ext == ".com" {
		return path, args, nil
	}
	if ext != ".cmd" {
		return "", nil, errors.New("VD_AGENT_LAUNCHER")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 64<<10))
	if err != nil {
		return "", nil, err
	}
	match := acpNodeShim.FindSubmatch(data)
	if match == nil {
		return "", nil, errors.New("VD_AGENT_LAUNCHER")
	}
	relative := filepath.Clean(string(match[1]))
	if !strings.HasPrefix(strings.ToLower(relative), `node_modules\`) {
		return "", nil, errors.New("VD_AGENT_LAUNCHER")
	}
	dir := filepath.Dir(path)
	entry := filepath.Join(dir, relative)
	if fi, err := os.Stat(entry); err != nil || fi.IsDir() {
		return "", nil, errors.New("VD_AGENT_LAUNCHER")
	}
	node := filepath.Join(dir, "node.exe")
	if fi, err := os.Stat(node); err != nil || fi.IsDir() {
		node, err = exec.LookPath("node.exe")
		if err != nil {
			return "", nil, errors.New("VD_AGENT_NODE_MISSING")
		}
	}
	return node, append([]string{entry}, args...), nil
}

func acpConfigureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

func acpOwnProcess(cmd *exec.Cmd) (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err == nil {
		var process windows.Handle
		process, err = windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
		if err == nil {
			err = windows.AssignProcessToJobObject(job, process)
			windows.CloseHandle(process)
		}
	}
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	return func() { _ = windows.CloseHandle(job) }, nil
}
