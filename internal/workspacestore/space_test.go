package workspacestore

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const spaceFixture = `{"name":"PRIVATE-CLOUD","notes":[{"id":"n","title":"PRIVATE note"}],"areas":[]}`

func TestValidationChecksEveryNotesField(t *testing.T) {
	store := historyStore(t)
	const private = `[{"id":"n","body":[{"type":"credentials"}]}]`
	for _, fields := range []string{
		`"notes":` + private + `,"notes":[]`,
		`"notes":[],"Notes":` + private,
		`"notes":null`,
		`"notes":[null]`,
	} {
		if store.ValidPayload([]byte(`{"name":"Shared","areas":[],` + fields + `}`)) {
			t.Fatal("accepted an invalid stored note list", fields)
		}
	}
}

func TestFolderSpaceConflictAndDeletion(t *testing.T) {
	store := historyStore(t)
	dir := t.TempDir()
	path := filepath.Join(dir, Filename)
	sibling := filepath.Join(dir, "keep.txt")
	if err := os.WriteFile(sibling, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	session, err := store.Create(dir, spaceFixture, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Open(dir, "password for another space", nil); !errors.Is(err, errChanged) {
		t.Fatal("silent plaintext downgrade", err)
	}
	info, err := store.Inspect(dir, nil)
	if err != nil || !info.Exists || info.Encrypted {
		t.Fatal(info, err)
	}
	if err = session.Save(spaceFixture); err != nil {
		t.Fatal(err)
	}
	now := readHistoryFile(t, path)
	times, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	changed := bytes.ReplaceAll(now, []byte("PRIVATE"), []byte("UPDATED"))
	if err = os.WriteFile(path, changed, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(path, times.ModTime(), times.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err = session.Save(spaceFixture); !errors.Is(err, errChanged) {
		t.Fatal("in-place overwrite was not detected", err)
	}
	if err = session.Delete(); !errors.Is(err, errChanged) {
		t.Fatal("deleted an external edit", err)
	}
	if !bytes.Equal(changed, readHistoryFile(t, path)) {
		t.Fatal("lost external version")
	}
	if session, _, err = store.Open(dir, "", nil); err != nil {
		t.Fatal(err)
	}
	// A replacement with the exact same content is still someone else's file.
	if _, err = WriteAtomic(path, changed, ".test-*"); err != nil {
		t.Fatal(err)
	}
	if err = session.Delete(); !errors.Is(err, errChanged) {
		t.Fatal("deleted external replacement", err)
	}
	if session, _, err = store.Open(dir, "", nil); err != nil {
		t.Fatal(err)
	}
	if err = session.Delete(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if string(readHistoryFile(t, sibling)) != "untouched" {
		t.Fatal("unrelated file changed")
	}
	if session, _, err = store.Open(dir, "", nil); !errors.Is(err, ErrMissing) {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatal(entries, err)
	}
}

func TestFolderSpaceCreationDoesNotClobber(t *testing.T) {
	store := historyStore(t)
	dir := t.TempDir()
	path := filepath.Join(dir, Filename)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := store.Create(dir, spaceFixture, "")
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success, exists := 0, 0
	for err := range results {
		switch {
		case err == nil:
			success++
		case errors.Is(err, ErrExists):
			exists++
		default:
			t.Fatal(err)
		}
	}
	if success != 1 || exists != 1 {
		t.Fatal(success, exists)
	}
	broken := []byte("existing unrelated file")
	if err := os.WriteFile(path, broken, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Inspect(dir, nil); !errors.Is(err, errCorrupt) {
		t.Fatal(err)
	}
	if _, err := store.Create(dir, spaceFixture, ""); !errors.Is(err, ErrExists) {
		t.Fatal(err)
	}
	if !bytes.Equal(broken, readHistoryFile(t, path)) {
		t.Fatal("overwrote unknown file")
	}
}

func TestConcurrentFolderUpdatesKeepAWholeRevision(t *testing.T) {
	store := historyStore(t)
	dir := t.TempDir()
	path := filepath.Join(dir, Filename)
	a := createHistorySession(t, store, dir, spaceFixture, "")
	b, _, err := store.Open(dir, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate the precise verification/publish interval, independently of scheduling.
	if err := WithWriteLock(path, func() error {
		if err := b.Save(spaceFixture); !errors.Is(err, errChanged) {
			t.Fatal("overlapping writer bypassed lock", err)
		}
		if err := b.Delete(); !errors.Is(err, errChanged) {
			t.Fatal("overlapping delete bypassed lock", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	type result struct {
		payload string
		err     error
	}
	done := make(chan result, 2)
	for i, session := range []*Session{a, b} {
		payload := strings.ReplaceAll(spaceFixture, "PRIVATE-CLOUD", []string{"First", "Second"}[i])
		go func() { <-start; done <- result{payload, session.Save(payload)} }()
	}
	close(start)
	first, second := <-done, <-done
	if first.err != nil {
		first, second = second, first
	}
	if first.err != nil || !errors.Is(second.err, errChanged) {
		t.Fatal("both writers published or neither succeeded", first.err, second.err)
	}
	if _, saved, err := store.Open(dir, "", nil); err != nil || saved != first.payload {
		t.Fatal("winner not preserved", err)
	}
}
