//go:build !windows

package main

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func captureDesktopWindow(ctx context.Context, previous desktopWindowState) desktopWindowState {
	if runtime.WindowIsMinimised(ctx) || runtime.WindowIsFullscreen(ctx) {
		return previous
	}
	if runtime.WindowIsMaximised(ctx) {
		if !previous.valid() {
			previous = desktopWindowState{Width: defaultWindowWidth, Height: defaultWindowHeight}
		}
		previous.Maximized = true
		return previous
	}
	x, y := runtime.WindowGetPosition(ctx)
	w, h := runtime.WindowGetSize(ctx)
	return desktopWindowState{X: x, Y: y, Width: w, Height: h}
}

func restoreDesktopWindow(ctx context.Context, s desktopWindowState) {
	// These Wails backends place windows relative to the current monitor. Fit
	// to it even when the display used in the previous session is gone.
	if screens, err := runtime.ScreenGetAll(ctx); err == nil {
		for _, screen := range screens {
			w, h := screen.Size.Width, screen.Size.Height
			if screen.IsCurrent && w > 0 && h > 0 {
				s.Width, s.Height = min(w, s.Width), min(h, s.Height)
				runtime.WindowSetSize(ctx, s.Width, s.Height)
				runtime.WindowSetPosition(ctx, max(0, min(s.X, w-s.Width)), max(0, min(s.Y, h-s.Height)))
				break
			}
		}
	}
	if s.Maximized {
		runtime.WindowMaximise(ctx)
	}
}
