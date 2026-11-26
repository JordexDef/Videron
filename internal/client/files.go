package client

import (
	"videron/frontend"
	"videron/internal/desktop"
	"videron/internal/workspacestore"
)

type SaveFileOptions struct {
	Title           string
	DefaultFilename string
	FilterName      string
	FilterPattern   string
}

// Earlier clients sent a language code instead of the translated dialog title.
func dialogTitle(value, russian, english string) string {
	switch value {
	case "ru", "":
		return russian
	case "en":
		return english
	default:
		return value
	}
}

func (a *App) PickFolder(title string) (string, error) {
	return a.hooks.PickFolder(a.runtimeContext(), dialogTitle(title, "Выберите папку", "Choose a folder"))
}

func (a *App) OpenFolder(path string) error {
	return desktop.OpenFolder(path)
}

// SaveDrawing writes only to a path chosen in the system Save As dialog.
func (a *App) SaveDrawing(payload, title string) (bool, error) {
	return a.saveFile([]byte(payload), ".drawing-*.tmp", SaveFileOptions{
		Title:           dialogTitle(title, "Сохранить рисунок", "Save drawing"),
		DefaultFilename: "Videron.excalidraw",
		FilterName:      "Excalidraw",
		FilterPattern:   "*.excalidraw",
	})
}

func (a *App) SaveLanguageTemplate(title string) (bool, error) {
	template, err := frontend.Files.ReadFile("languages/template.json")
	if err != nil {
		return false, err
	}
	return a.saveFile(template, ".language-*.tmp", SaveFileOptions{
		Title:           title,
		DefaultFilename: "Videron.language.json",
		FilterName:      "JSON",
		FilterPattern:   "*.json",
	})
}

func (a *App) saveFile(payload []byte, pattern string, options SaveFileOptions) (bool, error) {
	path, err := a.hooks.SaveFile(a.runtimeContext(), options)
	if err != nil || path == "" {
		return false, err
	}
	_, err = workspacestore.WriteAtomic(path, payload, pattern)
	return err == nil, err
}
