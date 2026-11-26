package client

import (
	"regexp"
	"sync"

	"videron/frontend"
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
)

// Read IDs from the same shipped icon packs as the picker. Only a catalog ID,
// never free-form text or SVG supplied by a note, can leave its envelope.
var publicMapIcons = sync.OnceValue(func() map[string]bool {
	icons := make(map[string]bool)
	entry := regexp.MustCompile(`\[\s*"((?:lucide|phosphor)/[a-z0-9-]+)"\s*,`)
	for _, pack := range []string{"vectors", "lucide-extra", "phosphor-extra"} {
		data, _ := frontend.Files.ReadFile("icons/" + pack + ".js")
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
	return a.library.Load(workspaceStore, a.revokeWorkspaceGrants)
}

func (a *App) IsProjectProtected() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.library.IsProjectProtected()
}

func (a *App) UnlockProject(password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.library.UnlockProject(workspaceStore, password, a.revokeWorkspaceGrants)
}

func (a *App) CatalogRevision() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.library.CatalogRevision()
}

func (a *App) SaveCatalogPatch(expectedRev, delta string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.library.SaveCatalogPatch(workspaceStore, expectedRev, delta)
}

func (a *App) LockProject() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.library.LockProject(a.revokeWorkspaceGrants)
}

// Called after the editor and storage queue have committed. Keep the resume
// target and session undo checkpoints in memory and revoke their unlock keys.
func (a *App) LockSession(noteID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.revokeWorkspaceGrants()
	a.library.LockSession(noteID)
}

func (a *App) TakeResumeNote() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.library.TakeResumeNote()
}

func (a *App) Save(payload string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.library.Save(workspaceStore, payload)
}

func (a *App) ProtectProject(payload, password string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.library.ProtectProject(workspaceStore, payload, password)
}

func (a *App) ChangeProjectPassword(payload, currentPassword, newPassword string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.library.ChangeProjectPassword(workspaceStore, payload, currentPassword, newPassword)
}

func (a *App) RemoveProjectPassword(payload, password string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.library.RemoveProjectPassword(workspaceStore, payload, password)
}
