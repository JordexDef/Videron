import {boardSummary} from './board-summary.js';
import {createNote} from './data.js';
import {tr} from './i18n.js';
import {noteTags} from './note-tags.js';
import {isProtectedNote} from './note-vault.js';
import {blockText} from './search-location.js';

const maxWriteLength = 256 * 1024;
const maxParagraphs = 4096;
const maxReadLength = 8 * 1024 * 1024;

function invalidRequest() {
  return new Error(tr('Некорректный запрос расширения.', 'Invalid extension request.'));
}

function checkParams(params, allowed) {
  if (!params || typeof params !== 'object' || Array.isArray(params) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(params)) ||
      Object.keys(params).some(key => !allowed.includes(key))) throw invalidRequest();
}

function paragraphs(lines) {
  return lines.map(text => ({type:'paragraph', runs:text ? [{text}] : []}));
}

function inputLines(text) {
  if (typeof text !== 'string') throw invalidRequest();
  if (!text) return [];
  if (text.length <= maxWriteLength) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n', maxParagraphs + 1);
    if (lines.length <= maxParagraphs) return lines;
  }
  throw new Error(tr('Слишком большой фрагмент текста для одной операции.', 'The text is too large for one operation.'));
}

function noteText(note) {
  if (note.type === 'data') return note.dataText;
  if (typeof note.plain === 'string') return note.plain;
  if (note.type === 'canvas') return boardSummary(note.board).plain;
  return note.body.map(block => block.type === 'drawing' && block.board ? boardSummary(block.board).plain : blockText(block)).join('\n');
}

function availableNote(workspace, id) {
  const note = typeof id === 'string' && workspace.notes.find(item => item.id === id);
  if (!note || isProtectedNote(note) || (note.type && !['text', 'canvas', 'data'].includes(note.type))) {
    throw new Error(tr('Выбранная заметка недоступна.', 'The selected note is unavailable.'));
  }
  return note;
}

// Permission checks and the selection belong to the host. Only plain strings cross the frame boundary.
export function applyExtensionNoteRequest(workspace, method, params, {noteId, position, onChange} = {}) {
  if (method === 'notes.read') {
    checkParams(params, []);
    const note = availableNote(workspace, noteId);
    const text = noteText(note);
    if (note.title.length + text.length > maxReadLength)
      throw new Error(tr('Эта заметка слишком велика для чтения расширением.', 'This note is too large for an extension to read.'));
    return {id:note.id, title:note.title, type:note.type || 'text', text};
  }
  if (typeof onChange !== 'function') throw invalidRequest();
  if (method === 'notes.create') {
    checkParams(params, ['title', 'text']);
    if (!Object.hasOwn(params, 'title') || typeof params.title !== 'string' || params.title.length > 512) throw invalidRequest();
    const lines = inputLines(Object.hasOwn(params, 'text') ? params.text : '');
    const note = createNote(position?.x ?? 0, position?.y ?? 0);
    note.title = params.title;
    note.body = paragraphs(lines);
    note.plain = lines.join('\n');
    note.weight = note.plain.length;
    note.tags = noteTags(note.title, note.plain);
    workspace.notes.push(note);
    onChange(note);
    return {id:note.id};
  }
  if (method !== 'notes.append') throw invalidRequest();
  checkParams(params, ['text']);
  if (!Object.hasOwn(params, 'text')) throw invalidRequest();
  const note = availableNote(workspace, noteId);
  if (note.type && note.type !== 'text')
    throw new Error(tr('Добавить абзацы можно только в текстовую заметку.', 'Paragraphs can only be appended to a text note.'));
  const lines = inputLines(params.text);
  if (!lines.length) throw invalidRequest();
  const before = noteText(note);
  let body = note.body;
  if (!body.length && before) body = paragraphs(before.split('\n'));
  // An untouched editor can store a single placeholder paragraph. Keep intentional empty styled blocks.
  if (body.length === 1 && body[0].type === 'paragraph' && !body[0].runs?.length &&
      Object.keys(body[0]).every(key => key === 'type' || key === 'runs')) body = [];
  const text = lines.join('\n');
  const suffix = body.length ? '\n' + text : text;
  const tagSource = !note.body.length && before ? before + suffix : text;
  const tags = [...new Set([...note.tags, ...noteTags(note.title, tagSource)])];
  Object.assign(note, {
    bodyVersion:1, body:[...body, ...paragraphs(lines)], plain:before + suffix, tags,
    weight:Math.max(before.length, Number.isFinite(note.weight) ? note.weight : 0) + suffix.length,
    modified:Date.now(),
  });
  onChange(note);
  return {id:note.id};
}
