# Videron user guide

**English** · [Русский](guide.ru.md)

Videron gives every note a place on a map. Your first workspace opens on an empty canvas. Choose **Explore the demo** to open a separate space with example notes and a drawing. Use the space switcher in the upper left to return to your own workspace.

## Run Videron on Windows

A local Windows build produces `build/bin/Videron.exe`. To switch versions, close Videron and run the new executable. Windows needs the Microsoft Edge WebView2 Runtime. The editor, canvas, fonts, search and built-in extension are bundled with the app. You can work on notes offline. [Build the desktop app](../README.md#build-the-desktop-app)

Use **Language** at the bottom of the sidebar to select English, Russian or an installed language pack. The setting takes effect immediately and is saved on this device. On first launch, look for **Язык** and select **English**.

On first launch, **Settings → Theme → Use system setting** follows the appearance of Windows or macOS. The map, editors and open dialogs update when the system switches themes. Choose **Light** or **Dark** to keep a fixed theme. Videron remembers this choice on this device across workspaces.

## Areas and notes

The sidebar groups notes by area. Notes outside any area appear at the top level. Click the arrow beside an area to collapse its branch, or click a note to open it. Use the arrow keys to navigate the tree and **Enter** to open the selected note.

## Data notes

Choose **Data** to create a note with a line editor. Type, paste text, or use **Insert file…**. When you insert a file into an empty note, its extension helps the editor select the format. Supported formats include JSON, JSON Lines, CSV, TSV, JavaScript, TypeScript, Python and SQL.

The **Lines** menu acts on the selected lines or, with no selection, the whole document. Sort in either direction, remove duplicate or empty lines, or trim whitespace. Removing duplicates keeps the first exact match. Sorting recognizes numbers in text, so `item2` comes before `item10`. **Ctrl+Z** undoes the whole operation, **Ctrl+F** opens find and replace, and **Ctrl+G** jumps to a line. On a Mac, use **⌘** for these editor shortcuts.

For CSV and TSV, use **Text** and **Table** beside the format selector to switch views. Click a column heading to sort and click again to reverse the order. To remove duplicates, select the columns to compare and use the deduplication command. For example, selecting city and date keeps the first row for each city–date pair in the current order, including that row's other fields.

Turn off the first-row header if your file begins with data. The choice is saved per note. The parser handles quoted fields, embedded delimiters and line breaks. Double-click a cell to jump to it in the source text. Undo sorting or deduplication directly in the table with **Ctrl+Z** or **⌘Z**.

With a cell selected, **Ctrl+C** copies its full value and **Ctrl+Arrow** moves to the edge of its row or column. **Enter** opens the cell in the source text. **Esc** cancels an ongoing sort or import and keeps the editor open.

## Use the map

Press **F1** on the map for its controls. With the map focused, **+** and **−** change zoom, **0** returns to 100%, and **F** fits the map in the window. On macOS, shortcut hints show **⌘** for Command.

In an open note, **Ctrl+S** (**⌘S** on Mac) writes your current edits to local storage immediately. You can save a formula while the caret is still in its field. Autosave continues as you type.

### Create, read and link notes

- Choose **New note** in the upper left to start a text note, or **New canvas** to arrange objects freely. The shortcuts are **Ctrl+N** and **Ctrl+Shift+N**. The editor's back button names your destination, whether it is the map, a list, an area or your search results.
- Double-click a node to open it, or drag to move it. Right-click to pin the note or create a link. Pinned notes stay in position when linked notes pull toward each other.
- Turn on **View → Free layout** to hide link lines and stop automatic movement. Drag a note or a whole selection to place it, including pinned notes. Drop the selection on a grid or stage track to snap the notes into the highlighted slots. Turning free layout off resumes automatic movement using the existing links.
- Right-click a note and choose **Appearance**, or select it and click the palette button. Set its shape, color and icon. Reset the color to inherit the area's color. The 288 SVG icons are searchable by English or Russian name. [Lucide](https://lucide.dev/license) · [Phosphor Duotone](https://github.com/phosphor-icons/core)
- Type the same tag, such as `#observation`, in two notes to link them. Their nodes will move toward each other. For a manual link, select the chain tool and click two nodes. The editor lists linked notes and backlinks.
- Zoom in to 175% to read a note on the map. Use the card's arrows to browse excerpts, the pin to remember an excerpt, and the title to open the editor. Toggle **Read as you zoom** under **View**.
- Use the mouse wheel to zoom. **H** switches to panning, **V** switches back to selection and **F** fits the whole map to the window. Right-click an empty spot to create a note there.

In **Appearance → Shape size**, leave **By content** selected or choose **Manual** for a fixed diameter. A note in a narrow grid cell fits the available space and returns to its chosen size when you take it out. In the icon picker, choose the center, left or right position before picking an icon. **Edge badges** changes their size or hides them. The preview shows your choices together with the note’s lock or pin.

If you sync notes with individual passwords, update Videron on each computer before saving a custom diameter or edge badge on those notes. Clients through 0.50.0 only recognize shape, center icon and color in an encrypted note’s public appearance.

Choose the pencil in the lower-left map toolbar (**P**) to draw around notes. Use the pen for a freehand outline or drag out a rectangle or ellipse. Hold **Shift** for a square or circle. With **Text**, click where the caption should start and type. **Enter** adds a line, **Ctrl+Enter** finishes, and a double-click opens the caption for editing.

Click a drawing’s outline on the map to select it. Drag the outline to move it or a handle to resize it. Hold **Shift** while resizing a shape to keep its proportions. For a caption, drag a corner to change its font size. Open the color swatch and move over the palette to preview the result on the map. Click to keep the color or press **Esc** to restore it. **Glow** adds a halo. Box-select several drawings and press **Delete** to remove them together. One **Ctrl+Z** restores them in their original stacking order.

To move a frame, its caption and its notes together, use the selection arrow (**V**) and drag a box around them. You can also add or remove individual objects with **Shift**+click. Choose **Group** below the selection or press **Ctrl+G**. Drag the frame's outline, the caption or a member note to move the whole group. **Ctrl+Z** restores every member's position in one step. Choose **Ungroup** or press **Ctrl+Shift+G** to edit the objects separately. On macOS, use **⌘** for these shortcuts.

Grouping a note from a grid frees its seat. Undoing the grouping restores the seat if it is still available. Before grouping individually encrypted notes in a synced space, update Videron on each computer. Older clients cannot read group membership on a locked note.

### Routes, charts and search

- In an open note, **Ctrl+F** finds text and **Ctrl+H** opens replacement (**⌘F** and **⌥⌘F** on macOS). Use **Enter** or **Shift+Enter** in the find field to move between matches. The text and canvas editors support case, whole-word and regular-expression matching. In regex mode, use `$1`, `$2` and so on to reuse captured text in the replacement. **Replace all** is a single undo step. **Esc** closes the panel. Credential entries are excluded.
- Open **Routes**, create a route, and click the notes in presentation order. Reorder the stops and pick an excerpt for each. Save the route and press Play. **←** and **→** move between stops. **Esc** returns to your original map view.
- Choose **Progress from table…** in an area's menu, then pick a cell and a target. A value of 7 with a target of 10 fills 70% of the outline. Choose **Chart from table…** on a note to link it to a series. Hover over the note to see the chart. Both features read from tables in the current space, including calculated values.
- On the map, **Ctrl+K** searches note titles, text and tags in the current space. Filter by area or pin status, enable case sensitivity, or use JavaScript regular expressions. Matches are highlighted. Press **Enter** to open a result. Regex searches run in a separate worker and time out if they take too long.
- **Ctrl+Shift+F** searches the space from the map or any note editor. In a text paragraph, **Ctrl+K** inserts a link. You can also use the magnifier at the top of the editor for workspace search. Click a result or press **Enter** to scroll to a match and briefly highlight it. This works in titles, paragraphs, code blocks, data notes and table cells in notes or on canvases. **Back to results** restores the query, filters and selected row.
- Search runs locally. Unlock an encrypted library or folder space to search its notes. Notes with their own password stay out of workspace results even while open in an editor. Locking the space closes its search.

### Organize areas

- Drag a selection box around notes or add notes with **Ctrl**-click or **Shift**-click. Drag any selected note onto an area's outline or a sidebar folder to move the group. For nested areas the deepest destination under the pointer is highlighted. **Esc** cancels the drag and **Ctrl+Z** restores the notes' positions and area membership.
- Choose **Move to area…** on a selection and enter a name to create an area around it. As you drag a note, the outline follows it and the other members. Move all members together and the outline and label move with them. Notes in the same area attract each other and keep a small gap. Neighboring areas push apart and their outlines compress at the point of contact. Nested areas stay within their parents. Pinned notes and notes in grid slots keep their coordinates.
- To nest an area, drag its title to the destination folder. Pause over a collapsed folder to reveal its contents. Drop on **Top level** to move it to the root, or press **Esc** to cancel. Use **…** beside the area name to create a child area, rename the folder or delete it. Deleting an area moves its child folders and notes up a level. If a parent grid is full, the notes move farther up the tree. Links are preserved.
- Press **Delete** and confirm to remove selected notes from the map or list. After a move or deletion, click **Undo** in the notification or press **Ctrl+Z** on the map or in the list. Each open space remembers the 20 most recent moves and deletions in order. Restoring a note brings back its content, appearance and links in both directions.

### Grids and stage tracks

- For aligned rows, click **+** beside **Areas** and choose **Grid**. Set 1–100 rows and columns. The name is optional for both grids and stage tracks. To place a grid at a specific spot, right-click the map there. Drag notes onto a slot marker. The highlight previews the slots the group will occupy, taking occupied slots into account. Notes stay in their slots and retain their links. Drag the title to move the whole grid. An unnamed grid shows a small grip at the top when you hover over it or select an empty cell. In the area's list view, **Show on map** takes you to its slots.
- Double-click an empty slot to create a text note, or an occupied one to open its note. Inside a regular grid, dragging a note onto an occupied slot swaps the two. When space allows, a group retains its layout as it moves. Within the same stage of a track you can also swap two notes. **Ctrl+Z** undoes the whole move.
- To bring columns closer together, drag the grid's lower-right corner left. Drag up to bring rows closer or diagonally to adjust both. For precise values, hover over the grid and click the settings button at the top. **Grid spacing** accepts separate horizontal and vertical distances from 24 to 320 map units. **Esc** cancels the drag. **Ctrl+Z** restores the spacing and note positions.
- To free a slot, drag one or more notes beyond the grid or track and drop them in an empty part of the map. Notes leaving a nested grid go to the nearest freeform parent area or, if there is none, to the top level. **Esc** cancels the drag and **Ctrl+Z** restores the original slots. For a single note, you can also choose **Take out of grid**.
- For a kanban-style workflow, create a **Stage track** area and name its stages. Double-click an empty slot to create a note at that stage. Drag one or more notes into a different stage column to move them into its available slots. **Ctrl+Z** restores their previous slots.
- Drag a stage heading or the track's empty background to move the track with its notes. Hold **Shift** while dragging to draw a selection box. The sliders button beside the track title opens its settings on the map. Double-click a stage heading to focus its name field. Undo a move or a saved settings change with **Ctrl+Z**.
- Hover over a stage heading to reveal its six-dot handle. On a touchscreen, tap the heading first. Drag the handle and use the insertion line between columns to position the stage. Its notes move with it in their existing rows. **Esc** cancels the gesture, and **Ctrl+Z** restores the previous order after a drop.
- Hover between stage headings, or at either end of a track, and click **+** to insert a stage. Enter its name and press **Enter**. To remove a stage, right-click its heading and choose **Delete stage…**. Move its notes into another stage or onto the map beside the track. If the destination needs more rows, the panel shows the resulting row count before you confirm. Undo an insertion or restore a deleted stage and its notes with **Ctrl+Z**.
- To remove a whole grid or stage track, use the pointer tool and drag a selection box around it, starting on empty map space. Once the entire grid is outlined, press **Delete**. You can also select the grid by clicking its title or an empty slot. Its notes and links stay on the map. To remove those notes too, draw a new selection box around them and press **Delete** again. **Ctrl+Z** undoes each deletion in turn.

## Lists, tags and folder links

Drag across consecutive paragraphs or list items to select text. To move it, press inside the selection and drag to the insertion caret, including between letters in a word. The move keeps text formatting. **Ctrl+Z** (or **⌘Z** on a Mac) undoes it in one step. You can also select several paragraphs and turn them into a list using the paragraph style menu.

To separate two sections of a text note, type `---` in its own paragraph and press **Enter**. A horizontal line appears and you can keep typing below it. To insert one in existing text, place the cursor where you want to split the paragraph and choose **Paragraph → Horizontal rule**. Click the line and press **Delete** to remove it.

Tags such as `#projects` are highlighted as you type. Click a tag to open another note with the same tag. If several notes match, choose one from the list beside the tag.

At the start of a paragraph, type `-`, `*` or `+` followed by a space for a bulleted list. For a numbered list, start with `1.` or `1)` and a space. **Enter** starts the next item. **Tab** nests the current item and **Shift+Tab** moves it up one level. Press **Enter** on an empty subitem to return to the parent list or on an empty top-level item to end the list.

Click **Task** on the formatting toolbar to turn the current paragraph into a checkbox. Choose **Cancellable task** for a second option, **×**. The active toolbar button stays highlighted. Click it again to remove the checkbox and keep the text. Canvas text areas have the same buttons on their floating toolbar.

Click the box beside a task to check it off and strike through the text, or click **×** to cancel it. Click the selected mark again to reopen the task. You can also start a task by typing `[ ]` followed by a space. **Enter** continues the list with an unchecked task. With the cursor in the task text, **Ctrl+Enter** (**⌘+Enter** on Mac) toggles completion.

In a text note with two or more tasks, the header shows your progress. It counts completed tasks out of the active total and lists cancelled tasks separately.

In a text note, click **Link to folder** and choose a directory. If you select text first, it becomes the link label. You can also enter a full path with **Ctrl+K**. On a canvas use **… → Link to folder…**. Click a folder link to open it in your file manager. On a canvas you can drag the link into position.

## Code and JSON in text notes

Paste a JSON object or array into an empty paragraph. The editor recognizes it and highlights keys, strings, numbers and booleans. Click **Format JSON** to indent the block and add line breaks. If the JSON contains a syntax error, the command reports the line and column and moves the caret there.

Click **Insert code block** (`</>`) to create a block at the caret or convert selected text in a paragraph to code. You can also paste a block fenced with triple backticks and a language name. Choose the syntax language or copy the code from the block header. **Ctrl+Enter** continues the note in a regular paragraph below the block. Space search includes the source code. The map takes its tags from the title and regular note content.

## Canvas notes and drawings

Double-click inside a rectangle, diamond or ellipse to add a label, or select the shape and press **Enter**. It stays centered as you move or resize the shape.

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

**Ctrl+Arrow** (**⌘+Arrow** on Mac) moves to the end of a run of filled cells, or across a gap to the next entry. Hold **Shift** as well to extend the selection.

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

Open the space switcher and choose **Create space…**. By default the space lives in the local library. To store it separately, choose a folder, including one managed by a cloud drive. Select **Encrypt space** to enable encryption before the first write. To move an existing local space into a folder, choose **Spaces on this computer… → Move to folder…**.

The selected folder contains the document `Videron.space` and a hidden `.videron-sync` directory with its history. When using a cloud drive, sync the **entire folder**, including the hidden directory, on both computers. On the second computer, choose **Open from folder…**. If you encrypted the space, enter the same password. Its encryption covers the document, attachments and history. Links to other folders retain their paths.

Videron merges independent changes to notes, including changes made offline. If both computers changed the same note, or one deleted it while the other edited it, compare **This computer** with **From the shared space**. **Later** keeps both versions for review. Choose **Compare versions** to return to them. If an update affects the open editor, you can finish typing before reviewing it. The space stores its own history and reuses repeated data.

**Sync with your own server.** Go to **Space → Your server…**, enter the Videron Sync address and password, and choose a project. The app remembers the verified address and chooses a working folder for you. In **Projects and folder…** you can move the current project to a folder of your choice or create a new, empty project with its own name. Version 0.47 also lets you rename the selected server project or delete it from the server for everyone. Downloaded copies remain accessible locally after a server deletion. A green dot at the bottom of the sidebar indicates a working connection. When the network returns, the client compares versions and downloads missing changes. An encrypted space requires its own password. Videron supports direct connections and TCP through Cloudflare Tunnel. [Set up and connect to Videron Sync](server-setup.md)

**Reconnect when you open a space.** Closing Videron ends the live connection. By default, reopening a linked space on this computer resumes sync, after unlocking it if needed. To connect manually, open **Your server…** and clear **Connect when this space opens**. This takes effect the next time you open that working copy. Click **Sync paused → Connect** at the bottom of the sidebar to sync for the current session. **Disconnect on this computer** removes the saved connection entirely.

On Windows, the local library normally lives at `%APPDATA%\Videron\workspace.json`. For spaces stored in separate folders, the library keeps the names, paths and encryption status. To remove a working copy from the list on one computer, choose **Spaces on this computer… → Remove from list**. Its files stay in their folder. The optional **Also delete the working copy from this folder** checkbox removes the notes and history from disk. The project remains on the Videron server.

Videron writes a snapshot to a temporary file, then replaces the previous version after a successful write. Closing the window normally waits for pending changes to save. Libraries with configurable spaces use schema version 3. Videron also reads schemas 1 and 2. Embedded images increase file size and memory use.

## Encryption

**Protect one note.** Open the note, click the lock in the upper right and enter the new password twice. Edits save in encrypted form while the editor is open. To remove individual encryption, click the lock again and enter the current password.

**Store logins and passwords.** In a text note, click the key in the toolbar or choose **Logins and passwords** from the paragraph menu. Videron asks you to protect the note before showing the first entry if it doesn't already have a note password. Enter a resource, login and password, then choose **Add entry** for another account. Inside the unlocked block you can search by resource or login, reveal a password or copy the login, password or `login:password` to the system clipboard. Workspace search and **Copy for AI** exclude the entries. Remove the credential blocks first if you want to turn off note encryption. Update all clients sharing the note before using credential blocks.

When you enter the password, **Keep this note unlocked** lets you choose how long you can reopen it on this computer. The first time, Videron selects **Until I close the note**. After a successful unlock, Videron preselects your choice the next time any note asks for its password on this computer. Choose **5**, **15** or **60 min** to start a timer when you unlock it. If the note is open when the timer expires, Videron saves your edits and locks it. **Until the session ends** lets you reopen the note throughout your current session in this space. Switching spaces, locking Videron or quitting it ends temporary access immediately. The file stays encrypted with every option.

Videron encrypts the title, text, searchable copy, tags, code, drawings, tables and attachments in the file. The map shows an **Encrypted note** node. Its shape, icon and color stay visible when you encrypt it. Right-click the node and choose **Appearance** to change them while it is locked. Notes encrypted in older versions keep their previous style private until you choose a visible style.

To give a locked note a name, right-click it and choose **Rename on map…**. Enter a **Map label** and press **Enter**. This label is visible without the note password on the map, in the list and in the sidebar. Clear it to restore **Encrypted note**. The title you see inside the editor stays encrypted. Update Videron on all computers sharing the space before assigning a map label or style to a locked note.

The visible appearance and optional label are stored with the map, alongside the node’s position, area membership, pin, manual links, timestamps and open count. Space search and extensions exclude the note's protected contents. Earlier versions saved in an unencrypted folder remain readable in its history, including copies on the sync server, other devices and in backups. To protect the entire history, enable folder encryption when creating the space, before you add notes.

**Protect the local library.** Open **Settings → Library encryption → Set password** at the bottom of the sidebar. This encrypts the local library file, including its spaces, the list of linked folders and installed extensions. When creating a space in its own folder, select **Encrypt space** to set that space’s password in the same form. Once you unlock a space, you can switch away and return to it. Videron asks for its password again the first time you open it after a lock or restart. Choose **Lock now** to lock access while the app is running. Use Settings to change or remove the library password. An individually protected note retains its own password inside an encrypted space.

**Auto-lock.** Under **Settings → Auto-lock**, select how long Videron may be idle or enter your own interval in minutes. The default is **Only in a new session**. Locking Windows immediately hides open protected content for all interval settings. Videron saves pending edits and locks the encrypted project and any open individually protected note. To return, enter the project password and then the note password if both apply. When only the note is protected, its password is enough.

Use a long, unique passphrase and store it in your password manager. Recovering access requires the password. The desktop app encrypts data with AES-256-GCM and derives the key with Argon2id using 64 MiB of memory, three passes and four threads. Each new password setup receives a random salt and each write uses a fresh random nonce. Earlier backups and separately exported files keep the form in which you saved them. [Argon2id parameters in RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html#section-4)

## AI agents and notes

Open the idea you want to share and click **AI** in the note editor. You can also right-click the note on the map.

**Paste a snapshot into a chat.** Choose **Copy for AI** and paste into the conversation. The Markdown includes headings, nested checklists, code with its language and the full contents of data notes. Each drawing describes the positions of shapes, paths, labels and arrow connections. Tables include cell addresses, formulas and their calculated values. Charts identify their source table and range.

Rich paste can also carry embedded images and drawing previews. A chat that accepts only plain text receives image captions and drawing geometry. Attach the original image separately if the agent needs to inspect its pixels. Copying an individually encrypted note requires opening it with its password first. The system clipboard then contains the readable copy.

**Register an existing agent once.** In **Settings → External agents → Add agent…**, enter a name you will recognize, such as “Codex on my laptop”. Choose **Add and copy configuration**. In that local MCP client’s settings, add the generated `videron` entry under `mcpServers`. If the client uses another format, transfer the command, arguments and environment variables. Replace any temporary Videron configuration from an earlier version. Reload the client’s MCP settings if needed. Keep the configuration private and register each client separately. Registrations belong to this computer.

**Share one idea.** With Videron open and unlocked, choose **AI → Share with agent…** on the note, select the registered client and choose **Read** or **Manage tasks**. Ask the agent to read the shared note. **Read** lets it read the idea and list its linked tasks. **Manage tasks** also lets it create and update those tasks. Other notes, including notes reached through ordinary links or tags, stay private. For an individually password-protected idea, unlock it and use **Copy for AI**.

The note header shows the client’s name and rights. Click the **×** beside its name, or choose **Stop sharing** in the agent dialog, to end access. One idea can be shared at a time. Switching spaces, locking Videron or closing the app also ends access. To share again, choose the client and rights on the desired note. The client keeps its configuration.

If you move or rename the Videron executable, open **Settings → External agents** in the new location. Click the copy button beside your client and replace its MCP configuration to update the executable path. Choose **Forget** to remove a client’s registration and end its access.

MCP clients can discover the tools with `tools/list` before a note is shared. To read shared content, call `read_idea` or `list_tasks`. When a result includes a `nextOffset`, pass it as `offset` together with the returned `scope` to fetch the next page. For `create_tasks` or `update_task`, pass the `scope` from `read_idea` for the current grant.

Each task is a separate note. Use space encryption to protect the idea and all its task notes together.

**Start an agent from the note.** Install and sign in to the ACP-compatible agent or adapter you want to use on this computer. Choose **AI → Run an agent…** on the note. Videron includes launch profiles for OpenCode (`opencode acp`), Qwen Code (`qwen --acp`), Claude Agent ACP (`claude-agent-acp`) and Codex ACP (`codex-acp`). For another adapter, enter its executable and arguments. Model selection, accounts and local inference are configured in the adapter.

Choose the working folder explicitly if the agent should implement the idea in an existing project. With the folder left empty, the agent starts in a temporary directory that is removed when the run ends. The selected folder is the process's working directory. Its access to files and network follows the installed adapter's own permissions. Enter an instruction such as “Split this idea into tasks, implement the first in the selected project and record how you tested it.” Start the run and respond to any permission requests from the adapter in Videron.

A run starts a fresh conversation by default. If the adapter supports resuming, **Continue the previous conversation in its working folder** reopens the last conversation for the same idea, adapter profile, folder and access level.

With task management enabled, the agent can create linked notes and report progress. Open a task from the checklist in the idea to see its description and result. For an external agent, a working task pulses on the map for 30 seconds after its latest successful tool call. The note stays shared when the pulsing stops. A finished task turns green and its checkbox fills. The area containing the idea shows progress by estimated effort. Completing a task of weight 3 contributes three times as much as completing a task of weight 1. Adding work can lower the percentage, and cancelled tasks leave the calculation.

## Extensions

**English** · [Русский](guide.ru.md#расширения)

### Language packs

Choose **Extensions → Install from JSON**, select a language pack, then click **Use language** beside its name. The language also appears in the sidebar selector. To install a revised translation, click **Update…** on the pack. Removing the active pack switches the interface to English.

To create a translation, choose **Save language template…** in Extensions. The template is bundled with Videron and is also available [in the repository](../frontend/languages/template.json). Give it a unique `id`, set `name` to the name readers will recognize in their language, and set `locale` to a language tag such as `fr` or `pt-BR`. Keep the English keys in `messages` and translate the values. Keep named placeholders such as `{total}`, the `$` placeholders in code-editor messages, and any leading or trailing spaces. You can omit a key to use the English label. A small pack can start with just two entries.

```json
{
  "apiVersion": 1,
  "type": "language",
  "id": "community.fr",
  "name": "Français",
  "locale": "fr",
  "messages": {
    "New note": "Nouvelle note",
    "{done} of {total} done": "Terminé : {done} sur {total}"
  }
}
```

Language packs contain text and work offline. They are stored in the local library and covered by its encryption. When a custom language is selected, the first password prompt after a restart or lock uses English until the library is unlocked. Your own notes and names stay as written.

### Custom views

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

Views run in a separate, sandboxed iframe with a Content Security Policy. Use the `language` field in `videron:data` to choose labels for your own view. The built-in Tag spectrum uses the app's translations.

| Message | Direction | Purpose |
| --- | --- | --- |
| `videron:ready` | Extension → app | Request the current space's data. |
| `videron:data` | App → extension | Delivers `apiVersion`, the active language tag (such as `ru`, `en` or `fr-CA`), and the `notes` and `areas` arrays. The language tag is in `language`. |
| `videron:open-note` | Extension → app | Open the note with the supplied `id`. |

A note record contains `id`, `title`, `type` (`text`, `canvas` or `data`), `appearance` (shape, icon and color), `tags`, `areaId`, `pinned`, `opens`, `x`, `y`, `weight` and `links`. The `links` array holds manual links. Compare `tags` to reconstruct tag links. An area record contains `id`, `parentId`, `name` and `color`.

### Note and workspace commands

For example, you can add a meeting action and its owner to the end of a note. Import the example JSON through **Extensions → Install from JSON**, then right-click a text note on the map, in the list or in the sidebar and choose **Add a meeting follow-up**. When several commands are available, open **Extension commands…** to see them. Review the requested access, enter the next step and click **Add to note**. [Meeting follow-up example](examples/meeting-follow-up.json)

To keep a daily journal, install the daily note example. Right-click an empty spot on the map and choose **Open today's note**. It opens today’s entry or creates one with the `#daily` tag. Workspace commands are also available in Extensions. [Daily note example](examples/daily-note.json)

Each example comes in English and Russian. To switch the language of its menu commands, remove the installed example in **Extensions** and install the file linked in the other guide. Notes you created with it stay in your space. [Russian examples](guide.ru.md#команды-для-заметок-и-пространства)

Add a `commands` array to a view manifest to register actions. Each entry has a unique `id`, a menu `title` and a `scope`. Use `note` for actions on a selected note, or `workspace` for actions in the active space. A note command may set `noteTypes` to any combination of `text`, `canvas` and `data` to appear only on those types.

Declare the methods your extension uses in `permissions`. Videron asks for access each time the extension opens and names the selected note when applicable. A view opened from Extensions can see map metadata and request permission to create notes. Launching a note command also lets the user share that note’s text or allow new paragraphs. Individually password-protected notes stay private.

| Method | Parameters | What it does |
| --- | --- | --- |
| `notes.read` | `{}` | Reads the selected note’s text and returns `{id, title, type, text}`. |
| `notes.append` | `{text}` | Adds plain text at the end of the selected text note. |
| `notes.create` | `{title, text?}` | Creates a text note in the active space and returns `{id}`. |

Every view has access to the built-in JavaScript SDK. Call `videron.start({onData, onCommand, onTheme})` with the callbacks your view uses. The example calls `await videron.notes.append(text)` when the user clicks its button. Other methods include `await videron.notes.read()`, `await videron.notes.create(title, text)` and `videron.openNote(id)`. Workspace commands can request creation. Reading and appending require a note command.

For direct messaging, the iframe sends `videron:ready` on startup. On a command launch, the app sends `videron:data` followed by `{type:"videron:command", id, noteId}`. Here `id` identifies the command and `noteId` is the selected note’s ID, or `null` for workspace commands. To call a method, send `{type:"videron:request", requestId, method, params}` to `parent` with `postMessage`. Give each request a unique string ID. Listen for messages from `parent` with `type:"videron:response"` and the same `requestId`. A successful response contains `result`, and a failed response contains an `error` string. The app chooses the target note from the user’s selection.

## Build from source

The desktop app uses Go with Wails 2 and a JavaScript interface with Canvas 2D. Go embeds the static `frontend/` files in the executable. Install the Go version specified in `go.mod`, then run the following command from the project root.

```sh
go run github.com/wailsapp/wails/v2/cmd/wails@v2.17.1 build -s -skipbindings -trimpath
```

For a browser preview, run `python -m http.server 8745 --bind 127.0.0.1 --directory frontend` and open `http://127.0.0.1:8745`. In the preview, data is kept in the browser's local storage. Run `node --test` with Node.js 22 or later for the formula, chart and drawing-format tests.

To build the desktop client for another operating system, follow the platform-specific setup instructions for its compiler and WebView. [Wails environment setup](https://v2.wails.io/docs/gettingstarted/installation/)
