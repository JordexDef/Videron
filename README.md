# Videron

**English** · [Русский](README.ru.md)

Videron is a local-first desktop app for keeping notes on a map. The size of each circle reflects how much it holds, and its glow shows how often you open it. Give two notes the same tag to link them. Zoom in to read a preview, or save a route through several notes to revisit them in order.

![Videron's demo map with linked notes grouped into three areas and a note tree in the sidebar](docs/media/videron-map.png)

[Download for Windows](https://github.com/JordexDef/Videron/releases/download/v0.48.1/Videron-0.48.1.exe) · [Download for macOS](https://github.com/JordexDef/Videron/releases/download/v0.48.1/Videron-0.48.1-macOS.dmg) · [All releases](https://github.com/JordexDef/Videron/releases)

## Working with notes

- **Arrange your map.** Drag notes into nested areas, pin them to a grid, or move them between stages of a project. The sidebar shows the same areas as a folder tree.
- **Write and draw.** Embed a sketch, image, code block, or table with formulas in a text note. Use a canvas note when you want to arrange those elements freely.
- **Work with data.** Open JSON, CSV, or TSV in a data note. For CSV and TSV, switch to the table view to sort by a column or remove duplicates using the fields you choose.
- **Work offline.** Create, edit and search your notes locally. You can sync a space when you want to use it on another computer.

On first launch, choose **English** from the language selector at the bottom of the sidebar. Select **Explore the demo** to open the example map in its own space.

## Encryption

- **One note.** Click the lock in the note editor to set a password. It protects the title, text, tags and attachments. The map still shows the node’s position, area and manual links. Workspace search excludes the note even while you have it open.
- **Local library.** Choose **Settings → Library encryption → Set password** to protect the library file on this computer. Each space stored in a separate folder has its own encryption setting.
- **A folder or synced project.** Select **Encrypt space** when creating the space. Videron encrypts the notes, attachments and revision history on your device before syncing. If the space started unencrypted, protecting a note later leaves its earlier plaintext revisions readable in the folder, on the server and in backups.

Videron uses AES-256-GCM with a key derived from your password using Argon2id. Unlock the space to search its contents locally. Under **Settings → Auto-lock**, choose an idle timeout or require the password only in a new session. Locking Windows also locks open protected content after saving your edits. [Encryption guide](docs/guide.md#encryption)

## Sync across computers

- **Your own server.** In the space switcher, choose **Your server…**, enter its address and server password, and select a project. Open the same project on the second computer. Videron creates a local working copy automatically. Click the status at the bottom of the sidebar to see the connection and the last successful sync.
- **A cloud-synced folder.** Create a space in a folder managed by your cloud drive. Sync the entire folder, including the hidden `.videron-sync` directory. On the second computer, choose **Open from folder…** in the space switcher.

You can edit offline with either method. Videron merges changes to different notes automatically. If both computers change the same note, or one deletes a note the other edited, Videron shows both versions and lets you choose what to keep. Connected clients receive change notifications from Videron Sync and exchange missing revisions when they reconnect.

The server password grants access to the projects on that server. In an unencrypted space, ordinary notes are readable in server storage. An encrypted project requires its own space password on each computer. The server stores its contents and history as ciphertext and can see project names, file sizes and upload times. [Connect two computers](docs/server-setup.md#connect-two-computers)

## Build the desktop app

Install Go 1.26.11 or later. Windows needs the Microsoft Edge WebView2 Runtime. On macOS, install the Xcode Command Line Tools with `xcode-select --install` if you don't already have them.

Run the following command from the directory containing `go.mod`. Go downloads Wails and its dependencies on the first build. The frontend, fonts, and icons are included in the repository.

```sh
go run github.com/wailsapp/wails/v2/cmd/wails@v2.17.1 build -s -skipbindings -trimpath
```

| System | Launch the app |
| --- | --- |
| Windows · PowerShell | `.\build\bin\Videron.exe` |
| macOS · Terminal | `open build/bin/Videron.app` |

## Run your own sync server

Videron Sync is a separate program that can host multiple projects on a home server or a VPS.

To build the server on Linux, run this command from the repository root. It places the binary next to the installer.

```sh
go build -trimpath -o deploy/linux/videron-sync ./cmd/videron-sync
```

The installer asks you to set a server password the first time you run it. [Server setup, backups, and updates](docs/server-setup.md)

## User guide

For keyboard shortcuts, map routes, table formulas, encryption, and the extension API, see the [Videron user guide](docs/guide.md).
