# Videron 0.11 usability review

**English** · [Русский](usability-0.11.ru.md)

On November 19, 2026, we walked through common tasks on Windows in a separate Edge profile. We used an empty space for first-run tasks and the built-in 27-note example for search. We used the mouse and keyboard in the visible interface and checked both English and Russian commands, including at a window size of 720 × 520. The findings come from these scripted checks. We did not collect participant ratings or task times.

## Changes verified in 0.11

| Task | Behavior in 0.10 | Result in 0.11 |
| --- | --- | --- |
| Link two notes from the list | **Link to another note** left the list open. Clicking the second note opened its editor. Switching to the map manually reset the tool. | The command opens the map with the source note selected and prompts for the second note. One click creates the link. After reloading, the second note showed the backlink. |
| Compare several search results | A search for `#` in the Research area returned seven notes. After opening the first, we had to retype the query and select the area again. | **Back to results** restores the query, area, options, and selected row. Down Arrow followed by Enter opens the next result. |
| Find another note while writing | The search icon was on the map. In the editor, the map's Ctrl+K search shortcut opened the link editor. | The search icon and Ctrl+Shift+F now work in text notes and canvas notes. Esc returns to editing. Ctrl+K still inserts a link in a text paragraph. |
| Return to the view that opened a note | The button said **Back to map** even when it returned to the note list or an area. | The button names its destination. Returning to the list places keyboard focus on the note that was just open. |

## Tasks completed in the review

- **Use a table and a drawing in one note.** We entered 3 and 7. The formula `=SUM(A1:A2)` returned 10, and selecting both cells showed an average of 5. We created a chart and drew a rectangle. After reloading, we checked the formula, its result, the rectangle, and the note text.
- **Write text around a JSON block.** We pasted an object into an empty paragraph, formatted it, and pressed Ctrl+Enter to continue writing below it. Reopening the note preserved the original values. We also checked the integer `9007199254740993`, duplicate keys, and navigation to a syntax error.
- **Work with a script fragment.** We pasted JavaScript inside triple backticks and checked highlighting, copying, undo, and redo. Searching the script's contents found the note. A `#` inside code did not create a map link.

We also tested the desktop app in WebView2 with an isolated Windows data folder. We created a block from the editor toolbar, formatted the JSON, closed the app, and restarted it. A regular expression matched a value inside the saved JSON. We opened the note and verified both occurrences of a repeated key and every digit of a long ID.

## Follow-up work identified during the review

| Priority | Observation in 0.11 | Proposed behavior and acceptance criteria |
| --- | --- | --- |
| 1. Jump to a search match | Search found a value on line 163 of a 165-line JSON block, but opening the result showed the first 12 lines. A match in paragraph 39 likewise opened at the top of the note. | Open the matching block, scroll to the match, and briefly highlight it. Start with text and code. For tables, select the matching cell. For a canvas note, center the matching object. |
| 2. Undo note deletion | After confirming deletion of a test note, Ctrl+Z in the list did not restore it. It was still absent after restarting. | Offer **Undo** immediately after deletion. Restore the note's text, attachments, position, and manually created links. |
| 3. Make charts easier to discover | The chart command was hidden with one cell selected. A chart button appeared after selecting A1:A2. | Show **Create chart** in the table menu with a short hint to select a range. This keeps the instruction available without a permanent label on the canvas. |

One more task to try with users is creating a note and immediately pressing Esc. In 0.11 this left an **Untitled** note in the library, even after restarting. An empty circle may be an intentional placeholder. Observing how people use these placeholders would help decide whether the behavior should change.
