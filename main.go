package main

import (
	"embed"
	"io/fs"
	"log"
	"os"

	"videron/internal/agentmcp"
	"videron/internal/desktop"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed frontend
var files embed.FS

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--agent-mcp" || os.Args[1] == "--agent-mcp-paired") {
		var err error
		if os.Args[1] == "--agent-mcp-paired" {
			err = agentmcp.ServePairedStdio(os.Stdin, os.Stdout, os.Getenv("VIDERON_AGENT_CLIENT"), os.Getenv("VIDERON_AGENT_KEY"))
		} else {
			err = agentmcp.ServeStdio(os.Stdin, os.Stdout, os.Getenv("VIDERON_AGENT_ENDPOINT"), os.Getenv("VIDERON_AGENT_TOKEN"))
		}
		if err != nil {
			log.Print(err)
			os.Exit(1)
		}
		return
	}
	assets, err := fs.Sub(files, "frontend")
	if err != nil {
		log.Fatal(err)
	}
	app := &App{}
	config := &options.App{
		Title:            "Videron",
		Width:            desktop.DefaultWindowWidth,
		Height:           desktop.DefaultWindowHeight,
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
			Theme:            windows.SystemDefault,
			DisablePinchZoom: true,
			WindowClassName:  desktop.WindowClassName,
		},
	}
	desktop.RememberWindow(config)
	err = wails.Run(config)
	if err != nil {
		log.Fatal(err)
	}
}
