package main

import (
	"regexp"
	"sync"

	"videron/internal/syncclient"
	"videron/internal/vault"
	"videron/internal/workspacestore"
)

// Keep the desktop storage errors stable across the Wails bridge.
var (
	errChanged  = syncclient.ErrChanged
	errInvalid  = vault.ErrInvalid
	errCorrupt  = vault.ErrCorrupt
	errLocked   = vault.ErrLocked
	errPassword = vault.ErrPassword
	errWeak     = vault.ErrWeak
	errVersion  = vault.ErrVersion
)

// Read IDs from the same shipped icon packs as the picker. Only a catalog ID,
// never free-form text or SVG supplied by a note, can leave its envelope.
var publicMapIcons = sync.OnceValue(func() map[string]bool {
	icons := make(map[string]bool)
	entry := regexp.MustCompile(`\[\s*"((?:lucide|phosphor)/[a-z0-9-]+)"\s*,`)
	for _, pack := range []string{"vectors", "lucide-extra", "phosphor-extra"} {
		data, _ := files.ReadFile("frontend/icons/" + pack + ".js")
		for _, match := range entry.FindAllSubmatch(data, -1) {
			icons[string(match[1])] = true
		}
	}
	return icons
})

var storedNotes = vault.NewNoteValidator(func(icon string) bool { return publicMapIcons()[icon] })

// storedNote applies the vault's policy when storage decodes a workspace.
type storedNote struct{}

func (*storedNote) UnmarshalJSON(data []byte) error {
	return storedNotes.Validate(data)
}

var workspaceStore = workspacestore.New[storedNote]()

func (a *App) Load() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	payload, err := a.catalog.Load(workspaceStore, a.projectKey, a.loaded, a.dropKeys)
	a.loaded = err == nil
	if err != nil {
		// A failed refresh cannot leave the previous library's grants usable.
		a.dropKeys()
		return "", err
	}
	if !a.catalog.Protected() {
		a.projectKey.Forget()
		a.projectKey = nil
	}
	return payload, nil
}

func (a *App) IsProjectProtected() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.catalog.Protected()
}

func (a *App) UnlockProject(password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	payload, key, err := a.catalog.Unlock(workspaceStore, password)
	if err != nil {
		return "", err
	}
	a.dropKeys()
	a.projectKey = key
	a.loaded = true
	return payload, nil
}

func (a *App) writeSnapshot(payload string, key *vault.Key) error {
	if !a.loaded {
		return errLocked
	}
	return a.catalog.SaveSnapshot(workspaceStore, payload, key)
}

func (a *App) CatalogRevision() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return "", errLocked
	}
	return a.catalog.Revision(), nil
}

func (a *App) SaveCatalogPatch(expectedRev, delta string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return "", errLocked
	}
	return a.catalog.SavePatch(workspaceStore, a.projectKey, expectedRev, delta)
}

func (a *App) LockProject() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.catalog.Protected() {
		return errInvalid
	}
	a.dropKeys()
	a.loaded = false
	return nil
}

// Called after the editor and storage queue have committed. Keep the resume
// target and session undo checkpoints in memory and revoke their unlock keys.
func (a *App) LockSession(noteID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.dropKeys()
	a.loaded = false
	a.resumeNote = noteID
}

func (a *App) TakeResumeNote() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return ""
	}
	id := a.resumeNote
	a.resumeNote = ""
	return id
}

func (a *App) Save(payload string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.writeSnapshot(payload, a.projectKey)
}

func (a *App) projectPassword(payload, password string) error {
	key, err := vault.NewKey(password)
	if err != nil {
		return err
	}
	if err := a.writeSnapshot(payload, key); err != nil {
		key.Forget()
		return err
	}
	a.projectKey.Forget()
	a.projectKey = key
	return nil
}

func (a *App) ProtectProject(payload, password string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded {
		return errLocked
	}
	if a.catalog.Protected() {
		return errInvalid
	}
	return a.projectPassword(payload, password)
}

func (a *App) ChangeProjectPassword(payload, currentPassword, newPassword string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded || a.projectKey == nil {
		return errLocked
	}
	if !a.projectKey.Verify(currentPassword) {
		return errPassword
	}
	return a.projectPassword(payload, newPassword)
}

func (a *App) RemoveProjectPassword(payload, password string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.loaded || a.projectKey == nil {
		return errLocked
	}
	if !a.projectKey.Verify(password) {
		return errPassword
	}
	if err := a.writeSnapshot(payload, nil); err != nil {
		return err
	}
	a.projectKey.Forget()
	a.projectKey = nil
	return nil
}
