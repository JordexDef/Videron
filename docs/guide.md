# Videron user guide

**English** · [Русский](guide.ru.md)

Videron gives every note a place on a map. Your first workspace opens on an empty canvas. Choose **Explore the demo** to open a separate space with example notes and a drawing. Use the space switcher in the upper left to return to your own workspace.

## Run Videron on Windows

A local Windows build produces `build/bin/Videron.exe`. To switch versions, close Videron and run the new executable. Windows needs the Microsoft Edge WebView2 Runtime. The editor, canvas, fonts, search and built-in extension are bundled with the app. You can work on notes offline. [Build the desktop app](../README.md#build-the-desktop-app)

Use **Language** at the bottom of the sidebar to switch between English and Russian. The setting takes effect immediately and is saved on this device. In the 0.47 release the initial language is Russian. Look for **Язык** and select **English**.

## Areas and notes

The sidebar groups notes by area. Notes outside any area appear at the top level. Click the arrow beside an area to collapse its branch, or click a note to open it. Use the arrow keys to navigate the tree and **Enter** to open the selected note.

## Data notes

Choose **Data** to create a note with a line editor. Type, paste text, or use **Insert file…**. When you insert a file into an empty note, its extension helps the editor select the format. Supported formats include JSON, JSON Lines, CSV, TSV, JavaScript, TypeScript, Python and SQL.

The **Lines** menu acts on the selected lines or, with no selection, the whole document. Sort in either direction, remove duplicate or empty lines, or trim whitespace. Removing duplicates keeps the first exact match. Sorting recognizes numbers in text, so `item2` comes before `item10`. **Ctrl+Z** undoes the whole operation, **Ctrl+F** opens find and replace, and **Ctrl+G** jumps to a line. On a Mac, use **⌘** for these editor shortcuts.

For CSV and TSV, use **Text** and **Table** beside the format selector to switch views. Click a column heading to sort and click again to reverse the order. To remove duplicates, select the columns to compare and use the deduplication command. For example, selecting city and date keeps the first row for each city–date pair in the current order, including that row's other fields.

Turn off the first-row header if your file begins with data. The choice is saved per note. The parser handles quoted fields, embedded delimiters and line breaks. Double-click a cell to jump to it in the source text. Undo sorting or deduplication directly in the table with **Ctrl+Z** or **⌘Z**.

## Use the map

### Create, read and link notes

- Choose **New note** in the upper left to start a text note, or **New canvas** to arrange objects freely. The shortcuts are **Ctrl+N** and **Ctrl+Shift+N**. The editor's back button names your destination, whether it is the map, a list, an area or your search results.
- Double-click a node to open it, or drag to move it. Right-click to pin the note or create a link. Pinned notes stay in position when linked notes pull toward each other.
- Right-click a note and choose **Appearance**, or select it and click the palette button. Set its shape, color and icon. Reset the color to inherit the area's color. The 288 SVG icons are searchable by English or Russian name. [Lucide](https://lucide.dev/license) · [Phosphor Duotone](https://github.com/phosphor-icons/core)
- Type the same tag, such as `#observation`, in two notes to link them. Their nodes will move toward each other. For a manual link, select the chain tool and click two nodes. The editor lists linked notes and backlinks.
- Zoom in to 175% to read a note on the map. Use the card's arrows to browse excerpts, the pin to remember an excerpt, and the title to open the editor. Toggle **Read as you zoom** under **View**.
- Use the mouse wheel to zoom. **H** switches to panning, **V** switches back to selection and **F** fits the whole map to the window. Right-click an empty spot to create a note there.

### Routes, charts and search

- Open **Routes**, create a route, and click the notes in presentation order. Reorder the stops and pick an excerpt for each. Save the route and press Play. **←** and **→** move between stops. **Esc** returns to your original map view.
- Choose **Progress from table…** in an area's menu, then pick a cell and a target. A value of 7 with a target of 10 fills 70% of the outline. Choose **Chart from table…** on a note to link it to a series. Hover over the note to see the chart. Both features read from tables in the current space, including calculated values.
- On the map, **Ctrl+K** searches note titles, text and tags in the current space. Filter by area or pin status, enable case sensitivity, or use JavaScript regular expressions. Matches are highlighted. Press **Enter** to open a result. Regex searches run in a separate worker and time out if they take too long.
- **Ctrl+Shift+F** searches the space from the map, a text note or a canvas note. You can also use the magnifier at the top of the editor. Click a result or press **Enter** to scroll to a match and briefly highlight it. This works in titles, paragraphs and code blocks, including long lines that scroll horizontally. **Back to results** restores the query, filters and selected row.

### Organize areas

- Drag a selection box around notes or add notes with **Ctrl**-click or **Shift**-click. Drag any selected note onto an area's outline or a sidebar folder to move the group. For nested areas the deepest destination under the pointer is highlighted. **Esc** cancels the drag and **Ctrl+Z** restores the notes' positions and area membership.
- Choose **Move to area…** on a selection and enter a name to create an area around it. As you drag a note, the outline follows it and the other members. Move all members together and the outline and label move with them. Notes in the same area attract each other and keep a small gap. Neighboring areas push apart and their outlines compress at the point of contact. Nested areas stay within their parents. Pinned notes and notes in grid slots keep their coordinates.
- To nest an area, drag its title to the destination folder. Pause over a collapsed folder to reveal its contents. Drop on **Top level** to move it to the root, or press **Esc** to cancel. Use **…** beside the area name to create a child area, rename the folder or delete it. Deleting an area moves its child folders and notes up a level. If a parent grid is full, the notes move farther up the tree. Links are preserved.
- Press **Delete** and confirm to remove selected notes from the map or list. After a move or deletion, click **Undo** in the notification or press **Ctrl+Z** on the map or in the list. Each open space remembers the 20 most recent moves and deletions in order. Restoring a note brings back its content, appearance and links in both directions.

### Grids and stage tracks

- For aligned rows, click **+** beside **Areas** and choose **Grid**. Give it a name and set 1–100 rows and 1–100 columns. To place a grid at a specific spot, right-click the map there. Drag notes onto a slot marker. The highlight previews the slots the group will occupy, taking occupied slots into account. Notes stay in their slots and retain their links. Drag the title to move the entire grid. In the area's list view, **Show on map** takes you to its slots.
- Double-click an empty slot to create a text note, or an occupied one to open its note. Inside a regular grid, dragging a note onto an occupied slot swaps the two. When space allows, a group retains its layout as it moves. Within the same stage of a track you can also swap two notes. **Ctrl+Z** undoes the whole move.
- To bring columns closer together, drag the grid's lower-right corner left. Drag up to bring rows closer or diagonally to adjust both. For precise values, hover over the grid and click the settings button by its name. **Grid spacing** accepts separate horizontal and vertical distances from 24 to 320 map units. **Esc** cancels the drag. **Ctrl+Z** restores the spacing and note positions.
- To free a slot, drag one or more notes beyond the grid or track and drop them in an empty part of the map. Notes leaving a nested grid go to the nearest freeform parent area or, if there is none, to the top level. **Esc** cancels the drag and **Ctrl+Z** restores the original slots. For a single note, you can also choose **Take out of grid**.
- For a kanban-style workflow, create a **Stage track** area and name its stages. Double-click an empty slot to create a note at that stage. Drag one or more notes into a different stage column to move them into its available slots. **Ctrl+Z** restores their previous slots.
- Drag a stage heading or the track's empty background to move the track with its notes. Hold **Shift** while dragging to draw a selection box. The sliders button beside the track title opens its settings on the map. Double-click a stage heading to focus its name field. Undo a move or a saved settings change with **Ctrl+Z**.
- Hover over a stage heading to reveal its six-dot handle. On a touchscreen, tap the heading first. Drag the handle and use the insertion line between columns to position the stage. Its notes move with it in their existing rows. **Esc** cancels the gesture, and **Ctrl+Z** restores the previous order after a drop.
- Hover between stage headings, or at either end of a track, and click **+** to insert a stage. Enter its name and press **Enter**. To remove a stage, right-click its heading and choose **Delete stage…**. Move its notes into another stage or onto the map beside the track. If the destination needs more rows, the panel shows the resulting row count before you confirm. Undo an insertion or restore a deleted stage and its notes with **Ctrl+Z**.
- To remove a whole grid or track, select its title or an empty slot and press **Delete**, or use the context menu. The notes and their links stay on the map. **Ctrl+Z** restores the grid and its notes to their previous positions.

## Lists, tags and folder links

Tags such as `#projects` are highlighted as you type. Click a tag to open another note with the same tag. If several notes match, choose one from the list beside the tag.

At the start of a paragraph, type `-`, `*` or `+` followed by a space for a bulleted list. For a numbered list, start with `1.` or `1)` and a space. **Enter** starts the next item. **Tab** nests the current item and **Shift+Tab** moves it up one level. Press **Enter** on an empty subitem to return to the parent list or on an empty top-level item to end the list.

In a text note, click **Link to folder** and choose a directory. If you select text first, it becomes the link label. You can also enter a full path with **Ctrl+K**. On a canvas use **… → Link to folder…**. Click a folder link to open it in your file manager. On a canvas you can drag the link into position.

## Code and JSON in text notes

Paste a JSON object or array into an empty paragraph. The editor recognizes it and highlights keys, strings, numbers and booleans. Click **Format JSON** to indent the block and add line breaks. If the JSON contains a syntax error, the command reports the line and column and moves the caret there.

Click **Insert code block** (`</>`) to create a block at the caret or convert selected text in a paragraph to code. You can also paste a block fenced with triple backticks and a language name. Choose the syntax language or copy the code from the block header. **Ctrl+Enter** continues the note in a regular paragraph below the block. Space search includes the source code. The map takes its tags from the title and regular note content.

## Canvas notes and drawings

Double-click inside a rectangle, diamond or ellipse to add a label. It stays centered as you move or resize the shape. Double-click again to edit it.

On a canvas, choose **Text**. Click to create a text area, or drag to set its initial size. When the text or an inserted image needs more room, the bottom edge grows downward. Drag an edge to move the area or a corner to resize it.

Click in the text to open the formatting toolbar above it. Text areas support headings, lists and subitems, links, images and code blocks. To change the area itself, select it and open **Object style**. Set the background and border separately, or choose **Text only** for a transparent background and no border. Choose **Save as default** to apply this look to new text areas on all canvases in the project.

**Delete** removes the selected canvas objects. While editing a label, it deletes the character at the caret or the selected text. To remove the whole label, press **Esc**, then **Delete**. **Ctrl+Z** undoes the last action. **Ctrl+Shift+Z** or **Ctrl+Y** redoes it.

Arrange text, images, lines and shapes freely on the canvas. With the selection tool, drag an object directly to move it, including a text object. A single click in text places the caret. Drag across characters while editing to select them. Double-click a blank part of the canvas to add a new label. Paste images from the clipboard, insert a file, or drag one in. Space search includes canvas text and hashtags in that text link notes on the map.

- Drag a selection box or add objects with **Shift**-click. A left-to-right box selects only fully enclosed shapes. A right-to-left box also picks up shapes it touches. **Ctrl+G** groups the selection and **Ctrl+Shift+G** removes one level of grouping. Groups can be nested. Drag a member to move the group, a corner to resize it, or the top handle to rotate it. Hold **Shift** to rotate in 15° increments. **Ctrl**-click to select one object inside a group.
- Use the lock button or **Ctrl+Shift+L** to lock or unlock selected objects. Alignment guides help match centers and edges while moving them. Hold **Ctrl** during a drag to turn off snapping temporarily.
- Drag a line or arrow endpoint to reposition it. When it approaches a shape, attachment points appear. An attached endpoint follows its point when the shape moves or rotates. Drag the midpoint of a segment to bend it into a smooth curve through the pointer. You can reposition that point later. For an existing polyline, choose **Corners → Rounded corners** in the style panel. Drag once to create a straight line or click successive points to draw a polyline. Finish with a double-click or **Enter**. **Alt**-click an intermediate point to remove the bend. Hold **Shift** to constrain the direction in 15° steps.
- In the style panel, choose the roughness of the outline, stroke pattern, corner style, colors and hatching. New labels use Excalifont, a handwriting font that supports Cyrillic. A regular font and a monospace font are also available. The pen responds to stylus pressure. When you draw with a mouse, the stroke width varies with movement. The font and drawing engines are bundled and work offline. [Excalifont](https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw/fonts/Excalifont) · [Rough.js](https://github.com/rough-stuff/rough) · [perfect-freehand](https://github.com/steveruizok/perfect-freehand)

To draw in a text note, place the caret between words or paragraphs and click **Insert drawing**. A drawing area appears with the pen selected. Clicking an existing drawing reveals its tools and lets you select an object immediately. Drag the lower-right corner to adjust width and height, or focus the corner and use the arrow keys. Click a paragraph to resume writing. **Esc** exits the area after the current action finishes. Changes save automatically. Inside the area, the mouse wheel scrolls the note and **Ctrl**+wheel zooms the drawing.

In both text notes and canvas notes, **Area and links** toggles the side panel. Videron remembers whether the panel is open.

Open **File** in the drawing toolbar to import or export an `.excalidraw` file. Supported objects include rectangles, diamonds, ellipses, lines, arrows, freehand strokes, text and embedded raster images. Group nesting, locks, attachments, pen pressure and font identifiers survive the round trip. Videron uses available local fonts to display each family and reports unsupported object types on import. [Excalidraw file format](https://docs.excalidraw.com/docs/codebase/json-schema)

## Floating tables

In a text note, place the caret in a paragraph and click **Insert table**. The table appears in the text flow. Start typing in A1. For a canvas note, choose **Add table**, drag its title or handle to move it, and drag a corner to resize it.

### Rows, columns and headers

Hover over the table and click the round handle below it to add a row, or the one on the right to add a column. Drag the handle farther to add several at once. To insert in the middle, right-click a row number or column letter and choose which side to insert on. Formulas and chart ranges follow the displaced cells.

Drag across row numbers or column letters to select several rows or columns. Alternatively, click the first heading and **Shift**-click the last. **Ctrl**-click adds or removes an individual row or column from the selection. Press **Delete**, or use the selection's context menu, to delete them. **Ctrl+Z** restores the entire group with its formulas. When ordinary cells are selected, **Delete** clears their contents.

Use **⋯** to hide the title, row numbers or column letters independently. The same menu lets you mark the first row or first column as headers. To mark a different row or column as headers, use a cell's context menu. With row numbers or column letters hidden, select a cell range and right-click inside it to delete the rows or columns it spans. Deleting every row or column leaves one empty row or column.

### Edit cells and fill series

Select a cell and start typing. **Enter** commits the edit. **Tab** moves right and wraps to the start of the next row at the edge. **Shift+Tab** moves in reverse. Drag or use **Shift** to select a range. Pasting one copied value fills the selection. Relative references in copied formulas adjust to the new position. Paste multiple cells to insert data in rows and columns.

To extend a series, select its starting cells and drag the round dot at the corner of the selection. For example, `1`, `3` continues with `5`, `7`. The dates `31.01.2024` and `29.02.2024` continue with `31.03.2024`, `30.04.2024`. A single number repeats, and a single date advances by one day. With `2`, `4`, `8` the app recognizes doubling. It can also continue weekday names, months and numbered labels such as “Stage 01.” Relative references shift as formulas fill.

Drag in any direction. When you select several columns and drag down, each column continues its own series. For whole-row or whole-column selections, the fill handle appears in the header. Hatching previews the target cells. A tooltip beside the pointer shows the address and value of the last cell. Hold **Ctrl** to cycle through the selected values, using calculated results for formulas. Press or release **Ctrl** at any point during the drag. Drag beyond the bottom or right edge to create additional rows or columns. **Esc** cancels the fill. **Ctrl+Z** restores the table to its state before the fill.

### Formulas and charts

Start a formula with `=`. Click a cell or select a range to insert its reference. References in the formula and their cells share a highlight color. References can point to another table in the same note, even under a different paragraph. For example, `=B2*C2` multiplies two cells, `=SUM('Sales'::D2:D8)` totals a range in a neighboring table, and `=ROUND(AVERAGE(B2:B8),2)` rounds the average to two decimal places. Renaming a table updates its references.

Start typing a function name such as `=s`. Suggestions beneath the formula bar include descriptions and syntax. To browse all functions, click **Functions** or press **Shift+F3**. Click a suggestion, or use the arrow keys and press **Tab** or **Enter** to insert it. Inside the parentheses, clicking A1 and then B1 produces `=SUM(A1,B1)`. Dragging from A1 to B1 adds the range `A1:B1`. **Esc** closes the suggestions.

The supported functions are `SUM`, `AVERAGE`, `COUNT`, `MIN`, `MAX`, `ABS` and `ROUND`. Russian aliases such as `СУММ` and `СРЗНАЧ` also work. Use semicolons to separate arguments when entering numbers with a decimal comma, for example `=ROUND(1,45;1)`. A dollar sign (`$`) fixes a row or column when copying a formula. A table can have up to 500 rows and 52 columns.

Select a range to see its sum, average and numeric count below the table. Click one of the totals to insert the corresponding formula into an empty cell below the range. Use **Create chart** beside the totals to create a separate chart object on the canvas. Include headers and labels in the selection to show them on the chart. Hover for exact values and switch between line and bar charts. Changes to source values or formulas update the chart.

Tables and charts appear as images in exported `.excalidraw` files. The file also contains the formulas, cell contents and chart references so Videron can restore the editable objects on import.

## Content and storage

A note is made up of versioned blocks. Text supports paragraphs, headings, quotes, indentation, font styles, colors and hyperlinks. Insert images from a file, the clipboard or by dragging them in. An embedded drawing or table retains its size and editable contents, including shapes, cells and charts.

Open the space switcher and choose **Create space…**. By default the space lives in the local library. To store it separately, choose a folder, including one managed by a cloud drive. Select **Encrypt the file with a password** to enable encryption before the first write. To move an existing local space into a folder, choose **Spaces on this computer… → Move to folder…**.

The selected folder contains the document `Videron.space` and a hidden `.videron-sync` directory with its history. When using a cloud drive, sync the **entire folder**, including the hidden directory, on both computers. On the second computer, choose **Open from folder…**. If you encrypted the space, enter the same password. Its encryption covers the document, attachments and history. Links to other folders retain their paths.

Videron merges independent changes to notes, including changes made offline. If both computers changed the same note, or one deleted it while the other edited it, compare **This computer** with **From the shared space**. **Later** keeps both versions for review. Choose **Compare versions** to return to them. If an update affects the open editor, you can finish typing before reviewing it. The space stores its own history and reuses repeated data.

**Sync with your own server.** Go to **Space → Your server…**, enter the Videron Sync address and password, and choose a project. The app remembers the verified address and chooses a working folder for you. In **Projects and folder…** you can move the current project to a folder of your choice or create a new, empty project with its own name. Version 0.47 also lets you rename the selected server project or delete it from the server for everyone. Downloaded copies remain accessible locally after a server deletion. A green dot at the bottom of the sidebar indicates a working connection. When the network returns, the client compares versions and downloads missing changes. An encrypted space requires its own password. Videron supports direct connections and TCP through Cloudflare Tunnel. [Set up and connect to Videron Sync](server-setup.md)

On Windows, the local library normally lives at `%APPDATA%\Videron\workspace.json`. For spaces stored in separate folders, the library keeps the names, paths and encryption status. To remove a working copy from the list on one computer, choose **Spaces on this computer… → Remove from list**. Its files stay in their folder. The optional **Also delete the working copy from this folder** checkbox removes the notes and history from disk. The project remains on the Videron server.

Videron writes a snapshot to a temporary file, then replaces the previous version after a successful write. Closing the window normally waits for pending changes to save. Libraries with configurable spaces use schema version 3. Videron also reads schemas 1 and 2. Embedded images increase file size and memory use.

## Encryption

**Protect one note.** Open a text or canvas note, click the lock in the upper right and enter the new password twice. Edits save in encrypted form while the editor is open. Opening the note again prompts for its password. To remove individual encryption, click the lock again and enter the current password.

Videron encrypts the title, text, searchable copy, tags, code, drawings, tables and attachments in the file. The map shows an **Encrypted note** node. Its position, area membership, pin, manual links, timestamps and open count remain map data. Space search and extensions exclude the note's protected contents. Earlier versions saved in an unencrypted folder remain readable in its history, including copies on the sync server, other devices and in backups. To protect the entire history, enable folder encryption when creating the space, before you add notes.

**Protect the whole project.** Open **Settings → Set password** at the bottom of the sidebar. This encrypts the entire local library file, including local spaces, the list of linked folders and installed extensions. A space stored in its own folder has a separate password, which Videron requests when opening it. Choose **Lock now** to lock access while the app is running. Use Settings to change or remove the project password. An individually protected note retains its own password inside an encrypted space.

**Auto-lock.** Under **Settings → Auto-lock**, select how long Videron may be idle or enter your own interval in minutes. The default is **Only in a new session**. Locking Windows immediately hides open protected content for all interval settings. Videron saves pending edits and locks the encrypted project and any open individually protected note. To return, enter the project password and then the note password if both apply. When only the note is protected, its password is enough.

Use a long, unique passphrase and store it in your password manager. Recovering access requires the password. The desktop app encrypts data with AES-256-GCM and derives the key with Argon2id using 64 MiB of memory, three passes and four threads. Each new password setup receives a random salt and each write uses a fresh random nonce. Earlier backups and separately exported files keep the form in which you saved them. [Argon2id parameters in RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html#section-4)

## Extensions

Open **Extensions → Tag spectrum** and select a tag to see its notes. Click a note in the list to open it.

You can import a custom view through the same window. Save this manifest as a `.json` file and choose it in the import dialog to display the number of notes exposed to the extension in the current space.

```json
{
  "apiVersion": 1,
  "id": "example.note-count",
  "name": "Note count",
  "description": "Shows how many notes are available in the active space.",
  "html": "<style>body{font:18px system-ui;color:#ededed;background:#171717}</style><p id='value'></p><script>addEventListener('message', e => { if (e.source === parent && e.data.type === 'videron:data') document.getElementById('value').textContent = 'Notes in this space: ' + e.data.notes.length }); parent.postMessage({type:'videron:ready'}, '*')</script>"
}
```

Views run in a separate, sandboxed iframe with a Content Security Policy. The built-in Tag spectrum uses the same API as imported views.

| Message | Direction | Purpose |
| --- | --- | --- |
| `videron:ready` | Extension → app | Request the current space's data. |
| `videron:data` | App → extension | Delivers `apiVersion`, `language` (`ru` or `en`), and the `notes` and `areas` arrays. |
| `videron:open-note` | Extension → app | Open the note with the supplied `id`. |

A note record contains `id`, `title`, `type` (`text`, `canvas` or `data`), `appearance` (shape, icon and color), `tags`, `areaId`, `pinned`, `opens`, `x`, `y`, `weight` and `links`. The `links` array holds manual links. Compare `tags` to reconstruct tag links. An area record contains `id`, `name` and `color`. This API supports custom views and navigation.

## Build from source

The desktop app uses Go with Wails 2 and a JavaScript interface with Canvas 2D. Go embeds the static `frontend/` files in the executable. Install the Go version specified in `go.mod`, then run the following command from the project root.

```sh
go run github.com/wailsapp/wails/v2/cmd/wails@v2.17.1 build -s -skipbindings -trimpath
```

For a browser preview, run `python -m http.server 8745 --bind 127.0.0.1 --directory frontend` and open `http://127.0.0.1:8745`. In the preview, data is kept in the browser's local storage. Run `node --test` with Node.js 22 or later for the formula, chart and drawing-format tests.

The 0.47 desktop release was tested on Windows. For macOS or Linux, build on the target system and check its WebView, including clipboard access, drawing, search and extensions. [Wails environment setup](https://v2.wails.io/docs/gettingstarted/installation/)
