package main

import "videron/internal/desktop"

func (a *App) PickFolder(title string) (string, error) {
	return desktop.PickFolder(a.ctx, dialogTitle(title, "Выберите папку", "Choose a folder"))
}

func (a *App) OpenFolder(path string) error {
	return desktop.OpenFolder(path)
}
