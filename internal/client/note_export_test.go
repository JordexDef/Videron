package client

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"videron/internal/noteexport"
)

func exportTestBundle() noteexport.Bundle {
	text := "# Notes\n"
	return noteexport.Bundle{Name: "My workspace", Files: []noteexport.File{{Path: "Notes.md", Text: &text}}}
}

func TestNoteExportUsesNativeDestination(t *testing.T) {
	a, _ := testStore(t)
	parent := t.TempDir()
	a.hooks.PickFolder = func(_ context.Context, title string) (string, error) {
		if title != "Choose destination" {
			t.Fatalf("picker title = %q", title)
		}
		return parent, nil
	}
	a.hooks.SaveFile = func(_ context.Context, opt SaveFileOptions) (string, error) {
		if opt.DefaultFilename != "My workspace.zip" || opt.FilterPattern != "*.zip" {
			t.Fatalf("archive dialog options = %#v", opt)
		}
		return filepath.Join(parent, "Selected location"), nil
	}
	bundle := exportTestBundle()
	result, err := a.WriteNoteExport("folder", "Choose destination", "", false, bundle)
	if err != nil || result == nil || result.Folder != filepath.Join(parent, "My workspace") {
		t.Fatalf("folder export = %#v, %v", result, err)
	}
	if got, err := os.ReadFile(filepath.Join(result.Folder, "Notes.md")); err != nil || string(got) != *bundle.Files[0].Text {
		t.Fatalf("exported note = %q, %v", got, err)
	}
	result, err = a.WriteNoteExport("zip", "Save archive", "", false, bundle)
	if err != nil || result == nil || result.Folder != parent {
		t.Fatalf("archive export = %#v, %v", result, err)
	}
	if _, err := os.Stat(filepath.Join(parent, "Selected location.zip")); err != nil {
		t.Fatal(err)
	}
}

func TestNoteExportRequiresConsentAndRevokesSelectionOnLock(t *testing.T) {
	a, _ := testStore(t)
	if err := a.ProtectProject(libraryPrefix+originalNote+librarySuffix, testPass); err != nil {
		t.Fatal(err)
	}
	parent := t.TempDir()
	picks := 0
	a.hooks.PickFolder = func(context.Context, string) (string, error) {
		picks++
		a.LockSession("")
		if _, err := a.UnlockProject(testPass); err != nil {
			t.Fatal(err)
		}
		return parent, nil
	}
	bundle := exportTestBundle()
	result, err := a.WriteNoteExport("folder", "Choose destination", "", false, bundle)
	if result != nil || !errors.Is(err, noteexport.ErrCancelled) || picks != 0 {
		t.Fatalf("export without consent = %#v, %v, picks %d", result, err, picks)
	}
	result, err = a.WriteNoteExport("folder", "Choose destination", "", true, bundle)
	if result != nil || !errors.Is(err, errLocked) || picks != 1 {
		t.Fatalf("export after lock = %#v, %v, picks %d", result, err, picks)
	}
	if entries, err := os.ReadDir(parent); err != nil || len(entries) != 0 {
		t.Fatalf("files after blocked export: %v, %v", entries, err)
	}
}
