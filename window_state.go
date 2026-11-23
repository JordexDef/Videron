package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	defaultWindowWidth  = 1340
	defaultWindowHeight = 860
	desktopWindowClass  = "VideronMainWindow"
)

// Window geometry belongs to this installation, independently of the open project.
type desktopWindowState struct {
	X         int  `json:"x"`
	Y         int  `json:"y"`
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	Maximized bool `json:"maximized"`
}

func (s desktopWindowState) valid() bool {
	return s.Width > 0 && s.Width <= 32768 && s.Height > 0 && s.Height <= 32768 &&
		s.X >= -131072 && s.X <= 131072 && s.Y >= -131072 && s.Y <= 131072
}

func rememberDesktopWindow(config *options.App) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return
	}
	path := filepath.Join(dir, "Videron", "window.json")
	var previous desktopWindowState
	if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &previous) == nil && previous.valid() {
		config.StartHidden = true
		var once sync.Once
		config.OnDomReady = func(ctx context.Context) {
			once.Do(func() {
				restoreDesktopWindow(ctx, previous)
				runtime.WindowShow(ctx)
			})
		}
	}
	beforeClose := config.OnBeforeClose
	config.OnBeforeClose = func(ctx context.Context) bool {
		if beforeClose(ctx) {
			return true
		}
		if state := captureDesktopWindow(ctx, previous); state.valid() {
			if data, err := json.Marshal(state); err == nil {
				_, _ = writeAtomic(path, data, ".window-*.tmp")
			}
		}
		return false
	}
}
