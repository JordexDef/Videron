import { createArea } from './areas.js';
import { colors, createNote } from './data.js';
import { contentRadius } from './icons/node-art.js';
import { sameWorkspaceValue } from './workspace-merge.js';

const folderGap = 104;

function areaName(text, limit = 80) {
  return Array.from(text.replace(/[\p{Cc}\u2028\u2029]/gu, ' ').trim()).slice(0, limit).join('').trimEnd();
}

function uniqueName(areas, base) {
  const names = new Set(areas.filter(area => area.parentId == null).map(area => area.name));
  let name = areaName(base);
  for (let n = 2; names.has(name); n++) {
    const suffix = ` · ${n}`;
    name = areaName(base, 80 - suffix.length) + suffix;
  }
  return name;
}

function arrange(folder) {
  const parts = folder.children.map(arrange);
  if (folder.notes.length) {
    const cols = Math.ceil(Math.sqrt(folder.notes.length));
    const pitch = Math.ceil(2 * Math.max(...folder.notes.map(contentRadius)) + 28);
    parts.unshift({notes: folder.notes, cols, pitch, width: cols * pitch,
      height: Math.ceil(folder.notes.length / cols) * pitch});
  }
  const extent = Math.max(...parts.map(part => part.width), Math.sqrt(parts.reduce((sum, part) =>
    sum + (part.width + folderGap) * (part.height + folderGap), 0)));
  let x = 0, y = 0, row = 0, width = 0;
  for (const part of parts) {
    if (x && x + part.width > extent) { x = 0; y += row + folderGap; row = 0; }
    part.x = x; part.y = y;
    width = Math.max(width, x + part.width);
    row = Math.max(row, part.height);
    x += part.width + folderGap;
  }
  return {parts, width, height: y + row};
}

function position(part, x, y) {
  for (const child of part.parts ?? []) position(child, x + child.x, y + child.y);
  part.notes?.forEach((note, i) => Object.assign(note, {
    x: x + (i % part.cols + .5) * part.pitch,
    y: y + (Math.floor(i / part.cols) + .5) * part.pitch,
  }));
}

// Plan the batch off the live map. Relative folders and references stay inside
// this copy even when a workspace already has notes with the same names.
export function planNoteImport(space, files, {name, bounds, center}) {
  if (!files.length) return null;
  const batch = {notes: [], areas: []};
  const root = createArea(batch, {name: uniqueName(space.areas, name), color: colors[1]});
  const rootFolder = {area: root, notes: [], children: []};
  const folders = new Map([['', rootFolder]]), ids = new Map();
  const imported = [];
  for (const file of files) {
    const {path: sourcePath, links, omittedImages, ...content} = file;
    const parts = sourcePath.split('/');
    parts.pop();
    let folder = rootFolder, path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (!folders.has(path)) {
        if (folders.size >= 6000) throw new Error('VD_IMPORT_LIMIT');
        const area = createArea(batch, {name: areaName(part) || part, color: colors[1], parentId: folder.area.id});
        const child = {area, notes: [], children: []};
        folders.set(path, child);
        folder.children.push(child);
      }
      folder = folders.get(path);
    }
    const note = Object.assign(createNote(0, 0, folder.area.id, content.type), content);
    ids.set(sourcePath, note.id);
    folder.notes.push(note);
    batch.notes.push(note);
    imported.push({note, links});
  }
  for (const {note, links} of imported) note.links = [...new Set(links.map(path => ids.get(path)))].filter(id => id && id !== note.id);
  const layout = arrange(rootFolder);
  const radius = Math.hypot(layout.width, layout.height) / 2;
  const x = bounds ? bounds.right + radius + 180 : center.x;
  const y = bounds ? (bounds.top + bounds.bottom) / 2 : center.y;
  position(layout, x - layout.width / 2, y - layout.height / 2);
  return {...batch, root};
}

function withoutMapMotion(note) {
  const {x, y, opens, ...rest} = note;
  return rest;
}

export function noteImportAction(batch) {
  return {kind: 'note-import', areas: batch.areas.map(area => ({...area})),
    notes: batch.notes.map(note => ({...withoutMapMotion(note), links: note.links.slice()}))};
}

// The import can be undone as a batch while its content and membership are
// still intact. Later edits or new references from another client take priority.
export function undoNoteImport(space, action) {
  const areas = new Map(action.areas.map(area => [area.id, area]));
  const notes = new Map(action.notes.map(note => [note.id, note]));
  let foundNotes = 0, foundAreas = 0;
  for (const note of space.notes) {
    if (notes.has(note.id)) {
      if (!sameWorkspaceValue(notes.get(note.id), withoutMapMotion(note))) return false;
      foundNotes++;
    } else if (areas.has(note.areaId) || note.links.some(id => notes.has(id))) return false;
  }
  for (const area of space.areas) {
    if (areas.has(area.id)) {
      if (!sameWorkspaceValue(areas.get(area.id), area)) return false;
      foundAreas++;
    } else if (areas.has(area.parentId)) return false;
  }
  if (foundNotes !== notes.size || foundAreas !== areas.size) return false;
  space.notes = space.notes.filter(note => !notes.has(note.id));
  space.areas = space.areas.filter(area => !areas.has(area.id));
  return true;
}
