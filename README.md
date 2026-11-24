# Videron

**English** · [Русский](README.ru.md) · [Documentation](docs/README.md)

Videron is a local-first desktop app for keeping notes on a map. The size of each circle reflects how much it holds, and its glow shows how often you open it. Give two notes the same tag to link them. Zoom in to read a preview, or save a route through several notes to revisit them in order.

![Videron's demo map with linked notes grouped into three areas and a note tree in the sidebar](docs/media/videron-map.png)

## Download Videron 0.50.0

Download the desktop app to work with your notes. Choose Videron Sync if you want to host your own server.

| System | Desktop app | Videron Sync server |
| --- | --- | --- |
| Windows | [x64 EXE](https://github.com/JordexDef/Videron/releases/download/v0.50.0/Videron-0.50.0.exe) · [ARM64 EXE](https://github.com/JordexDef/Videron/releases/download/v0.50.0/Videron-0.50.0-windows-arm64.exe) | [x64 EXE](https://github.com/JordexDef/Videron/releases/download/v0.50.0/Videron-Sync-0.50.0-windows-amd64.exe) · [ARM64 EXE](https://github.com/JordexDef/Videron/releases/download/v0.50.0/Videron-Sync-0.50.0-windows-arm64.exe) |
| macOS | [DMG for Apple silicon and Intel](https://github.com/JordexDef/Videron/releases/download/v0.50.0/Videron-0.50.0-macOS.dmg) | [Archive for Apple silicon and Intel](https://github.com/JordexDef/Videron/releases/download/v0.50.0/Videron-Sync-0.50.0-macOS-universal.tar.gz) |
| Linux | [x64](https://github.com/JordexDef/Videron/releases/download/v0.50.0/Videron-0.50.0-linux-amd64.tar.gz) · [ARM64](https://github.com/JordexDef/Videron/releases/download/v0.50.0/Videron-0.50.0-linux-arm64.tar.gz) | [x64](https://github.com/JordexDef/Videron/releases/download/v0.50.0/Videron-Sync-0.50.0-linux-amd64.tar.gz) · [ARM64](https://github.com/JordexDef/Videron/releases/download/v0.50.0/Videron-Sync-0.50.0-linux-arm64.tar.gz) |

On Windows, run the desktop EXE. On macOS, open the DMG and drag Videron into Applications. On Linux, extract the desktop archive and run `./Videron` from that folder. The Linux builds target Ubuntu 24.04 with GTK 3 and WebKitGTK 4.1. If WebKitGTK is missing, install the runtime with `sudo apt install libwebkit2gtk-4.1-0`.

[Server setup](docs/server-setup.md) · [Release notes and checksums](https://github.com/JordexDef/Videron/releases/tag/v0.50.0)

## Working with notes

- **Arrange your map.** Drag notes into nested areas, pin them to a grid, or move them between stages of a project. The sidebar shows the same areas as a folder tree.
- **Write and draw.** Embed a sketch, image, code block, or table with formulas in a text note. Use a canvas note when you want to arrange those elements freely.
- **Work with data.** Open JSON, CSV, or TSV in a data note. For CSV and TSV, switch to the table view to sort by a column or remove duplicates using the fields you choose.
- **Work offline.** Create, edit and search your notes locally. You can sync a space when you want to use it on another computer.

In the development build, **AI → Copy for AI** copies a note with its drawings and table formulas. Register a local MCP client once in **Settings → External agents**, then choose which idea it may read or manage tasks for. You can also launch an installed ACP agent from the note and track its tasks on the map. [AI agents and notes](docs/guide.md#ai-agents-and-notes)

On first launch, choose **English** from the language selector at the bottom of the sidebar. Select **Explore the demo** to open the example map in its own space. To use another language, install a translation through **Extensions** or create one from the bundled template. [Language packs](docs/guide.md#language-packs)

## Encryption

- **One note.** Click the lock in the note editor to set a password. It protects the title, text, tags and attachments. The node's position, area, manual links, shape, icon and color remain visible. **Rename on map…** lets you give it an optional label visible without the note password. Workspace search excludes the note even while you have it open.
- **Local library.** Choose **Settings → Library encryption → Set password** to protect the library file on this computer. Each space stored in a separate folder has its own encryption setting.
- **A folder or synced project.** Select **Encrypt space** when creating the space. Videron encrypts the notes, attachments and revision history on your device before syncing. If the space started unencrypted, protecting a note later leaves its earlier plaintext revisions readable in the folder, on the server and in backups.

Videron uses AES-256-GCM with a key derived from your password using Argon2id. Unlock the space to search its contents locally. Under **Settings → Auto-lock**, choose an idle timeout or require the password only in a new session. Locking Windows also locks open protected content after saving your edits. [Encryption guide](docs/guide.md#encryption)

## Sync across computers

- **Your own server.** In the space switcher, choose **Your server…**, enter its address and server password, and select a project. Open the same project on the second computer. Videron creates a local working copy automatically. Click the status at the bottom of the sidebar to see the connection and the last successful sync.
- **A cloud-synced folder.** Create a space in a folder managed by your cloud drive. Sync the entire folder, including the hidden `.videron-sync` directory. On the second computer, choose **Open from folder…** in the space switcher.

You can edit offline with either method. Videron merges changes to different notes automatically. If both computers change the same note, or one deletes a note the other edited, Videron shows both versions and lets you choose what to keep. Connected clients receive change notifications from Videron Sync and exchange missing revisions when they reconnect.

The server password grants access to the projects on that server. In an unencrypted space, ordinary notes are readable in server storage. An encrypted project requires its own space password on each computer. The server stores its contents and history as ciphertext and can see project names, file sizes and upload times. [Connect two computers](docs/server-setup.md#connect-two-computers)

## Build the desktop app

To build from source, install Go 1.26.11 or later. Windows needs the Microsoft Edge WebView2 Runtime. On macOS, install the Xcode Command Line Tools with `xcode-select --install` if you don't already have them.

Run the following command from the directory containing `go.mod`. Go downloads Wails and its dependencies on the first build. The frontend, fonts, and icons are included in the repository.

```sh
go run github.com/wailsapp/wails/v2/cmd/wails@v2.17.1 build -s -skipbindings -trimpath
```

On Ubuntu 24.04, build against WebKitGTK 4.1 with these commands.

```sh
sudo apt install build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev
go run -tags webkit2_41 github.com/wailsapp/wails/v2/cmd/wails@v2.17.1 build -tags webkit2_41 -s -skipbindings -trimpath
```

| System | Launch the app |
| --- | --- |
| Windows · PowerShell | `.\build\bin\Videron.exe` |
| macOS · Terminal | `open build/bin/Videron.app` |
| Linux · Terminal | `./build/bin/Videron` |

Keep one local desktop build at the path shown above. Close the running app before rebuilding and use the same filename each time. Stage release packages and checksums in a separate directory.

## Run your own sync server

Download Videron Sync for the computer that will host your projects. On Linux with systemd, unpack the server archive and run `sudo ./install.sh sync.example.net`, replacing the example domain with your address. The installer asks for a server password and starts the service. On Windows and macOS, you can run the server from a terminal. [Server setup, backups, and updates](docs/server-setup.md)

## User guide

The guide covers keyboard shortcuts, map routes, table formulas, encryption and the extension API. [English](docs/guide.md) · [Русский](docs/guide.ru.md)
