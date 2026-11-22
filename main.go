package main

import (
	"embed"
	"io/fs"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed frontend
var files embed.FS

func main() {
	assets, err := fs.Sub(files, "frontend")
	if err != nil {
		log.Fatal(err)
	}
	app := &App{}
	err = wails.Run(&options.App{
		Title:            "Videron",
		Width:            1340,
		Height:           860,
		MinWidth:         720,
		MinHeight:        520,
		BackgroundColour: options.NewRGB(23, 23, 23),
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		OnBeforeClose:    app.beforeClose,
		Bind:             []interface{}{app},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "afe0835b-a0ad-44f7-bef5-437391d33cb8",
			OnSecondInstanceLaunch: app.focusWindow,
		},
		Windows: &windows.Options{
			Theme:            windows.Dark,
			DisablePinchZoom: true,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
