import {areaDisplayName} from './areas.js';
import {normalizeBoard} from './board.js';
import {noteWorkbooks} from './board-tables.js';
import {tr} from './i18n.js';
import {indentOf, listMarkers, taskStateOf} from './note-lists.js';
import {isProtectedNote} from './note-vault.js';
import {addressOf} from './table-engine.js';

const attachmentFolder = '_attachments';
const imageType = /^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,/i;
const imageSignatures = {
  avif:/^[\s\S]{4}ftypavi[fs][\s\S]{4}/, bmp:/^BM/, gif:/^GIF8[79]a/,
  jpeg:/^\xff\xd8\xff/, png:/^\x89PNG\r\n\x1a\n/, webp:/^RIFF[\s\S]{4}WEBPVP/,
};
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const deviceName = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|(?:com|lpt)[0-9¹²³])$/i;
const validTag = /^[\p{L}\p{N}_][\p{L}\p{N}_/-]*$/u;
const encoder = new TextEncoder();

function cleanName(value, fallback) {
  const name = String(value ?? '').normalize('NFC')
    .replace(/[<>:"/\\|?*#^[\]%\p{Cc}\p{Cf}\p{Cs}]/gu, ' ').replace(/\s+/gu, ' ')
    .replace(/^[. ]+|[. ]+$/g, '') || fallback;
  return deviceName.test(name.split('.', 1)[0].trimEnd()) ? '_' + name : name;
}

function fitComponent(text, max) {
  let bytes = 0, name = '';
  for (const ch of text) {
    bytes += encoder.encode(ch).length;
    if (bytes > max) break;
    name += ch;
  }
  return name.replace(/[. ]+$/g, '');
}

function foldedName(name) {
  // Keep both canonical equivalents and case-insensitive filesystems in mind.
  return name.toUpperCase().toLowerCase().replaceAll('ß', 'ss').normalize('NFC');
}

function namer() {
  const folders = new Map();
  return (folder, value, fallback, extension = '') => {
    if (!folders.has(folder)) folders.set(folder, {used:new Set(folder ? [] : [attachmentFolder]), next:new Map()});
    const {used, next} = folders.get(folder), stem = cleanName(value, fallback);
    const first = fitComponent(stem, 120 - extension.length) + extension;
    const group = foldedName(first);
    for (let i = next.get(group) ?? 1; ; i++) {
      const suffix = (i > 1 ? ` (${i})` : '') + extension;
      const component = i > 1 ? fitComponent(stem, 120 - suffix.length) + suffix : first;
      const key = foldedName(component);
      if (used.has(key)) continue;
      used.add(key);
      next.set(group, i + 1);
      return folder ? `${folder}/${component}` : component;
    }
  };
}

function areaPaths(areas, allocate) {
  const byId = new Map(areas.map(area => [area.id, area]));
  const paths = new Map();
  for (const start of areas) {
    const chain = new Set();
    let area = start;
    while (area && !paths.has(area.id) && !chain.has(area.id)) {
      chain.add(area.id);
      area = byId.get(area.parentId);
    }
    let parent = paths.get(area?.id) ?? '';
    for (const id of [...chain].reverse()) {
      parent = allocate(parent, areaDisplayName(byId.get(id)), 'Area');
      paths.set(id, parent);
    }
  }
  return paths;
}

function encodeDestination(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

function relativeLink(source, target) {
  const from = source.split('/').slice(0, -1), to = target.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const up = '../'.repeat(from.length - common);
  return (up || './') + to.slice(common).map(encodeDestination).join('/');
}

function markdownText(value, inlineLabel = false) {
  return String(value ?? '').replaceAll('\0', '\uFFFD').replace(/\r\n?/g, '\n')
    .replace(inlineLabel ? /[\\`*_\[\]<>~%$#]/g : /[\\`*_\[\]<>~%$]/g, '\\$&')
    .replace(/^([ \t]{0,3})(?=(?:#{1,6}(?:\s|$)|[-+=]{1,}(?:\s|$)))/gm, '$1\\')
    .replace(/^([ \t]{0,3}\d{1,9})([.)])(?=\s|$)/gm, '$1\\$2');
}

function labelText(value) {
  return markdownText(String(value ?? '').replace(/\s+/g, ' ').trim(), true);
}

function fenced(value, language) {
  const text = String(value ?? '').replaceAll('\0', '\uFFFD');
  let width = 3;
  for (const tick of text.matchAll(/`{3,}/g)) width = Math.max(width, tick[0].length + 1);
  const fence = '`'.repeat(width);
  const info = !['plain', 'auto', 'text'].includes(language) && /^[\w+#.-]+$/.test(language ?? '') ? language : '';
  return `${fence}${info}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

function runText(run) {
  const text = markdownText(run.text);
  if (!text.trim()) return text;
  const mark = '*'.repeat((run.bold ? 2 : 0) + (run.italic ? 1 : 0));
  const visible = mark ? text.replace(/^(\s*)([\s\S]*?)(\s*)$/, `$1${mark}$2${mark}$3`) : text;
  if (!run.folderPath && /^(?:https?:\/\/|mailto:)/i.test(run.href ?? '')) {
    try {
      const href = new URL(run.href).href.replace(/[\s<>]/g, encodeDestination);
      return `[${visible.replace(/\n/g, ' ')}](<${href}>)`;
    } catch {
      // A damaged or old URL still has its visible label.
    }
  }
  return visible;
}

function frontMatter(note, title) {
  const tags = [...new Set((note.tags ?? []).map(value => String(value).replace(/^#/, '')))]
    .filter(tag => validTag.test(tag) && /[^\d]/.test(tag));
  const quote = value => JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  const lines = ['---', 'title: ' + quote(title)];
  if (tags.length) lines.push('tags:', ...tags.map(tag => '  - ' + quote(tag)));
  lines.push('---');
  return lines.join('\n');
}

function tableMarkdown(table, workbook) {
  const cell = (row, col) => {
    const address = addressOf(row, col), raw = table.cells[address] ?? '';
    return markdownText(raw.startsWith('=') ? workbook.value(table.id, address) : raw)
      .replaceAll('|', '\\|').replace(/\n/g, '<br>');
  };
  const row = get => '| ' + Array.from({length: table.cols}, (_, col) => get(col)).join(' | ') + ' |';
  const header = table.headerRows.includes(0);
  const lines = [row(col => header ? cell(0, col) : addressOf(0, col).slice(0, -1)), row(() => '---')];
  for (let index = Number(header); index < table.rows; index++) lines.push(row(col => cell(index, col)));
  return `${labelText(table.name)}\n\n${lines.join('\n')}`;
}

function validImagePayload(payload, type) {
  // Check the encoding and MIME signature without decoding the image in JS.
  if (payload.length % 4 || payload.match(/^[A-Za-z0-9+/]+={0,2}$/)?.[0].length !== payload.length) return false;
  if (payload.endsWith('==') && (base64Alphabet.indexOf(payload.at(-3)) & 15)) return false;
  if (payload.endsWith('=') && !payload.endsWith('==') && (base64Alphabet.indexOf(payload.at(-2)) & 3)) return false;
  return imageSignatures[type].test(atob(payload.slice(0, 24)));
}

function imageMarkdown(block, source, context) {
  const alt = String(block.alt || tr('Изображение','Image'));
  const match = typeof block.src === 'string' && imageType.exec(block.src);
  if (!match || block.src.length === match[0].length) {
    context.summary.skippedImages++;
    return labelText(alt);
  }
  const kind = match[1].toLowerCase(), extension = kind === 'jpeg' ? 'jpg' : kind;
  const type = extension === 'jpg' ? 'jpeg' : kind, prefix = `data:image/${type};base64,`;
  const payload = block.src.slice(match[0].length);
  const src = block.src.startsWith(prefix) ? block.src : prefix + payload;
  let path = context.images.get(src);
  if (!path) {
    if (!validImagePayload(payload, type)) {
      context.summary.skippedImages++;
      return labelText(alt);
    }
    const filename = alt.split(/[/\\]/).at(-1).replace(/\.(?:png|jpe?g|gif|webp|bmp|avif)$/i, '');
    path = context.allocate(attachmentFolder, filename, 'Image', '.' + extension);
    context.images.set(src, path);
    context.files.push({path, src});
  }
  return `![${labelText(alt)}](${relativeLink(source, path)})`;
}

function noteScenes(note) {
  return note.type === 'canvas' ? [note] : note.body?.filter(block => block?.type === 'drawing') ?? [];
}

function credentialCount(blocks) {
  return blocks?.filter(block => block?.type === 'credentials').length ?? 0;
}

// Count from the persisted records. A title or decrypted body retained in an
// open editor is intentionally never used by workspace export.
export function markdownExportCounts(space) {
  const result = {notes:0, skippedProtected:0, redactedCredentials:0};
  for (const note of space.notes) {
    if (isProtectedNote(note)) { result.skippedProtected++; continue; }
    result.notes++;
    result.redactedCredentials += credentialCount(note.body);
    for (const scene of noteScenes(note)) {
      for (const element of (scene.board ?? scene).elements ?? [])
        if (element?.type === 'text') result.redactedCredentials += credentialCount(element.body);
    }
  }
  return result;
}

function serializeNote(note, source, targets, context) {
  const scenes = new Map(), books = noteWorkbooks();
  for (const scene of noteScenes(note)) {
    const {elements} = normalizeBoard(scene);
    scenes.set(scene, elements);
    books.register(scene, elements);
  }

  function sceneText(scene) {
    const elements = scenes.get(scene);
    const workbook = books.workbook(scene, elements);
    const parts = elements.map(item => {
      if (item.type === 'image') return imageMarkdown(item, source.path, context);
      if (item.type === 'table') return tableMarkdown(item, workbook);
      if (item.type === 'text') return item.body ? blocksText(item.body) : markdownText(item.text);
      return markdownText(item.label);
    }).filter(Boolean);
    if (elements.some(item => !['text','image','table'].includes(item.type))) context.summary.omittedDrawings++;
    return parts.join('\n\n');
  }

  function blocksText(blocks) {
    const markers = listMarkers(blocks);
    return blocks.map((block, i) => {
      let content;
      switch (block.type) {
        case 'credentials': content = '*' + tr('Учётные данные исключены','Credentials omitted') + '*'; break;
        case 'code': content = fenced(block.text, block.language); break;
        case 'image': content = imageMarkdown(block, source.path, context); break;
        case 'drawing': content = sceneText(block); break;
        case 'divider': content = '---'; break;
        default: {
          content = (block.runs ?? []).map(runText).join('');
          if (block.type === 'heading' || block.type === 'subheading') {
            content = (block.type === 'heading' ? '## ' : '### ') + content.replace(/\n/g, ' ');
          } else if (block.type === 'quote') {
            content = '> ' + content.replace(/\n/g, '\n> ');
          } else if (markers[i]) {
            const state = taskStateOf(block);
            const marker = state === 'done' ? '- [x]' : state === 'pending' ? '- [ ]' : state === 'cancelled' ? '- [-]' :
              markers[i] === '•' ? '-' : markers[i];
            const indent = '    '.repeat(indentOf(block));
            content = indent + marker + ' ' + content.replace(/\n/g, '\n' + indent + ' '.repeat(marker.length + 1));
          }
        }
      }
      const separator = i === 0 ? '' : markers[i] && markers[i - 1] ? '\n' : '\n\n';
      return separator + content;
    }).join('');
  }

  const body = note.type === 'data' ? fenced(note.dataText, note.dataLanguage) :
    note.type === 'canvas' ? sceneText(note) : note.body?.length ? blocksText(note.body) : markdownText(note.plain);
  const links = [...new Set(note.links ?? [])].flatMap(id => {
    const target = targets.get(id);
    return id !== note.id && target ? [`- [${labelText(target.title)}](${relativeLink(source.path, target.path)})`] : [];
  });
  const sections = [frontMatter(note, source.title), body];
  if (links.length) sections.push('## ' + tr('Связанные заметки','Linked notes') + '\n\n' + links.join('\n'));
  return sections.filter(Boolean).join('\n\n').trimEnd() + '\n';
}

export function buildMarkdownExport(space) {
  const summary = {...markdownExportCounts(space), images:0, skippedImages:0, omittedDrawings:0};
  const allocate = namer(), directories = areaPaths(space.areas, allocate);
  const targets = new Map(), files = [], images = new Map();
  for (const note of space.notes) {
    if (isProtectedNote(note)) continue;
    const title = note.title.trim() || tr('Без названия','Untitled');
    const folder = directories.get(note.areaId) ?? '';
    targets.set(note.id, {title, path:allocate(folder, title, 'Untitled', '.md')});
  }
  const context = {files, images, allocate, summary};
  for (const note of space.notes) {
    const target = targets.get(note.id);
    if (target) files.push({path:target.path, text:serializeNote(note, target, targets, context)});
  }
  summary.images = images.size;
  return {directories:[...directories.values()], files, summary};
}
