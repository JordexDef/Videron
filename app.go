package main

import (
	"context"

	"videron/internal/client"
	"videron/internal/desktop"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App keeps the window.go.main.App binding used by the frontend.
type App struct {
	*client.App
	lifecycle client.Lifecycle
}

func newApp() *App {
	app, lifecycle := client.New(client.Hooks{
		Emit:       runtime.EventsEmit,
		Quit:       runtime.Quit,
		PickFolder: desktop.PickFolder,
		PickImportFile: func(ctx context.Context, title string) (string, error) {
			return runtime.OpenFileDialog(ctx, runtime.OpenDialogOptions{
				Title:   title,
				Filters: []runtime.FileFilter{{DisplayName: "Markdown / CSV / TSV / ZIP", Pattern: "*.md;*.markdown;*.csv;*.tsv;*.zip"}},
			})
		},
		SaveFile: func(ctx context.Context, file client.SaveFileOptions) (string, error) {
			return runtime.SaveFileDialog(ctx, runtime.SaveDialogOptions{
				Title:           file.Title,
				DefaultFilename: file.DefaultFilename,
				Filters:         []runtime.FileFilter{{DisplayName: file.FilterName, Pattern: file.FilterPattern}},
			})
		},
	})
	return &App{App: app, lifecycle: lifecycle}
}

func (a *App) focusWindow(_ options.SecondInstanceData) {
	if ctx := a.lifecycle.Context(); ctx != nil {
		runtime.WindowUnminimise(ctx)
		runtime.WindowShow(ctx)
	}
}
