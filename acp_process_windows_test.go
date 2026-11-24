//go:build windows

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestACPWindowsNpmLauncher(t *testing.T) {
	dir := t.TempDir()
	entry := filepath.Join(dir, "node_modules", "synthetic agent", "entry.js")
	if err := os.MkdirAll(filepath.Dir(entry), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, nil, 0600); err != nil {
		t.Fatal(err)
	}
	node := filepath.Join(dir, "node.exe")
	if err := os.WriteFile(node, nil, 0600); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(dir, "agent.cmd")
	if err := os.WriteFile(shim, []byte(`@ECHO off
endLocal & "%_prog%" "%dp0%\node_modules\synthetic agent\entry.js" %*
`), 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"--profile", "spaces & %literal% | (characters)"}
	program, argv, err := acpExecutable(shim, args)
	if err != nil || program != node || !reflect.DeepEqual(argv, append([]string{entry}, args...)) {
		t.Fatalf("unexpected node launcher: %s %q %v", program, argv, err)
	}
	if err := os.WriteFile(shim, []byte("@ECHO custom script"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := acpExecutable(shim, args); err == nil {
		t.Fatal("unexpected shell launcher")
	}
}
