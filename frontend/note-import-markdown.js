import {blockTagText, richPlain} from './board-rich-text.js';
import {codeLanguage} from './code-block.js';
import {noteTags} from './note-tags.js';

const markdown = /\.(?:md|markdown)$/i;
const dataFile = /\.(csv|tsv)$/i;
const raster = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i;
const imageBudget = 32 * 1024 * 1024;
const uriScheme = /^[a-z][a-z0-9+.-]*:/i;
const allowedTag = /^[\p{L}\p{N}_][\p{L}\p{N}_/-]*$/u;
const fileName = path => path.slice(path.lastIndexOf('/') + 1);
const folderName = path => path.slice(0, Math.max(0, path.lastIndexOf('/')));

function comparable(path) {
  return path.normalize('NFC').toLowerCase();
}

function addUnique(index, key, item) {
  index.set(key, index.has(key) ? null : item);
}

function referenceIndex(items, extension = null) {
  const paths = new Map(), folded = new Map(), basenames = new Map();
  for (const item of items) {
    paths.set(item.path, item);
    addUnique(folded, comparable(item.path), item);
    const name = fileName(item.path);
    addUnique(basenames, comparable(name), item);
    if (extension?.test(name)) addUnique(basenames, comparable(name.replace(extension, '')), item);
  }
  return {paths, folded, basenames};
}

function cleanPath(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

function decodePath(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function findReference(value, from, index, wiki, note) {
  const name = value.replaceAll('\\', '/').trim();
  if (!name || uriScheme.test(name) || name.startsWith('//') || name.includes('\0')) return null;
  const root = cleanPath(name);
  const relative = cleanPath([folderName(from), name].filter(Boolean).join('/'));
  const candidates = name.startsWith('/') ? [root]
    : /^\.{1,2}\//.test(name) ? [relative]
    : wiki ? [root, relative] : [relative, root];
  for (const path of candidates) {
    if (!path) continue;
    const names = note && !markdown.test(path) && !dataFile.test(path) ? [path, path + '.md', path + '.markdown'] : [path];
    for (const candidate of names) {
      const match = index.paths.get(candidate) || index.folded.get(comparable(candidate));
      if (match) return match;
    }
  }
  return name.includes('/') ? null : index.basenames.get(comparable(name)) || null;
}

function resolveReference(address, from, index, wiki, note) {
  const path = address.split('#', 1)[0];
  // Wiki names are literal. Markdown destinations typically URL-encode spaces
  // and punctuation. Accept the other spelling when no exact match exists.
  const decoded = decodePath(path);
  const first = wiki ? path : decoded, second = wiki ? decoded : path;
  return findReference(first, from, index, wiki, note) ||
    (first !== second ? findReference(second, from, index, wiki, note) : null);
}

function yamlAtom(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); }
    catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text.replace(/\s+#.*$/, '').trim();
}

function splitFrontMatter(lines) {
  const out = {start:0, title:'', tags:[], other:''};
  if (lines[0]?.trim() !== '---') return out;
  const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line));
  if (end < 1 || !lines.slice(1, end).some(line => /^[\w.-]+:/.test(line))) return out;

  out.start = end + 1;
  const other = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const property = /^(title|tags):[ \t]*(.*)$/i.exec(line);
    if (!property) { other.push(line); continue; }
    const [, key, value] = property;
    if (key.toLowerCase() === 'title') {
      const title = yamlAtom(value);
      if (title && !/^[|>]/.test(title)) out.title = title;
      else other.push(line);
      continue;
    }

    const first = i;
    let raw = [];
    if (value.startsWith('[') && value.endsWith(']')) raw = value.slice(1, -1).split(',');
    else if (value.trim()) raw.push(value);
    else {
      while (i + 1 < end) {
        const item = /^[ \t]*-[ \t]+(.*)$/.exec(lines[i + 1]);
        if (!item) break;
        raw.push(item[1]);
        i++;
      }
    }
    const tags = raw.map(part => yamlAtom(part).replace(/^#/, '')).filter(Boolean);
    for (const tag of tags) if (allowedTag.test(tag)) out.tags.push(tag);
    if (tags.some(tag => !allowedTag.test(tag))) {
      for (let row = first; row <= i; row++) other.push(lines[row]);
    }
  }
  out.other = other.join('\n').trim();
  return out;
}

// Only file references, basic formatting and normal web URLs become native
// note content. Anything else remains literal source text.
const inlinePattern = /\\(?<escape>[\\`*_{}\[\]()#+.!|>~-])|(?<code>(?<!`)`+[^`\n]+`+)|(?<wikiImage>!)?\[\[(?<wiki>[^[\]\n]{1,2048})\]\]|(?<image>!)?\[(?<label>[^[\]\n]{0,1024})\]\((?<target><[^>\n]{1,2048}>[^\n()]*|[^()\n]*(?:\([^()\n]*\)[^()\n]*){0,4})\)/gu;
const emphasis = /\*\*\*([^*\n]+)\*\*\*|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu;

function readEmphasis(text, runs) {
  let start = 0;
  for (const m of text.matchAll(emphasis)) {
    if (start < m.index) runs.push({text:text.slice(start, m.index)});
    const [, both, strong, strongUnder, italic, italicUnder] = m;
    const value = both ?? strong ?? strongUnder ?? italic ?? italicUnder;
    if (!value.trim() || value.trim() !== value) runs.push({text:m[0]});
    else {
      const run = {text:value};
      if (both || strong || strongUnder) run.bold = true;
      if (both || italic || italicUnder) run.italic = true;
      runs.push(run);
    }
    start = m.index + m[0].length;
  }
  if (start < text.length) runs.push({text:text.slice(start)});
}

function markdownAddress(target) {
  const value = target.trim();
  if (value.startsWith('<')) return value.slice(1, value.indexOf('>'));
  return value.replace(/[ \t]+(?:"[^"]*"|'[^']*')$/, '').replace(/\\([()[\]<> ])/g, '$1');
}

function externalURL(address) {
  if (!/^(?:https?:\/\/|mailto:)/i.test(address)) return '';
  try { return new URL(address).href; }
  catch { return ''; }
}

function addTextBlocks(body, text, style, scope) {
  let start = 0, runs = [];
  const pushRuns = () => {
    if (runs.length) body.push({...style, runs});
    runs = [];
  };
  for (const m of text.matchAll(inlinePattern)) {
    if (start < m.index) readEmphasis(text.slice(start, m.index), runs);
    start = m.index + m[0].length;
    const {escape, code, wiki, wikiImage, label, image, target} = m.groups;
    if (escape || code) { runs.push({text:escape === '#' ? m[0] : escape || code}); continue; }
    const [destination, display] = wiki === undefined ? [markdownAddress(target), label] : wiki.split('|', 2);
    const href = !wikiImage && !image && externalURL(destination);
    const note = !href && !image && resolveReference(destination, scope.path, scope.notes, wiki !== undefined, true);
    if (wikiImage || image) {
      const art = resolveReference(destination, scope.path, scope.images, wiki !== undefined, false);
      if (art && art.src.length <= scope.budget.remaining) {
        scope.budget.remaining -= art.src.length;
        pushRuns();
        const alt = wikiImage && (!display || /^\d+(?:x\d+)?$/i.test(display)) ? fileName(art.path) : display || fileName(art.path);
        body.push({type:'image', src:art.src, alt});
        continue;
      }
      if (!note) scope.omittedImages++;
    }
    if (note && note.path !== scope.path) scope.links.add(note.path);
    if (href) runs.push({text:display || destination, href});
    else if (note && !wikiImage) runs.push({text:display || destination});
    else runs.push({text:m[0]});
  }
  if (start < text.length) readEmphasis(text.slice(start), runs);
  pushRuns();
}

function fenceEnd(line, marker) {
  const end = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
  return end?.[0] === marker[0] && end.length >= marker.length;
}

function parseBlocks(lines, start, scope) {
  const body = [], indents = [];
  let pending = [], kind = 'paragraph';
  function flush(type = kind) {
    if (pending.length) addTextBlocks(body, pending.join('\n'), {type}, scope);
    pending = [];
    kind = 'paragraph';
  }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const fence = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)/.exec(line);
    if (fence) {
      flush(); indents.length = 0;
      const [, spacing, marker, language] = fence, code = [];
      while (i + 1 < lines.length) {
        const next = lines[++i];
        if (fenceEnd(next, marker)) break;
        code.push(next.startsWith(spacing) ? next.slice(spacing.length) : next);
      }
      body.push({type:'code', text:code.join('\n'), language:codeLanguage(language)});
      continue;
    }
    if (pending.length && kind === 'paragraph' && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
      flush(line.trimStart()[0] === '=' ? 'heading' : 'subheading'); continue;
    }
    if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) {
      flush(); indents.length = 0; body.push({type:'divider'}); continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
    if (heading) {
      flush(); indents.length = 0;
      addTextBlocks(body, heading[2].replace(/[ \t]+#+[ \t]*$/, ''), {type:heading[1].length <= 2 ? 'heading' : 'subheading'}, scope);
      continue;
    }
    const quoted = /^ {0,3}>[ \t]?(.*)$/.exec(line);
    if (quoted) {
      if (kind !== 'quote') flush();
      kind = 'quote'; indents.length = 0; pending.push(quoted[1]); continue;
    }
    const list = /^([ \t]*)([-+*]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line);
    if (list) {
      flush();
      const indent = list[1].replaceAll('\t', '    ').length;
      while (indents.at(-1) > indent) indents.pop();
      if (indents.at(-1) !== indent) indents.push(indent);
      const depth = Math.min(indents.length - 1, 8);
      const style = {type:'paragraph', listStyle:list[2].endsWith('.') ? 'decimal' : list[2].endsWith(')') ? 'parenthesis' : 'bullet'};
      if (depth) style.indent = depth;
      const task = /^\[([ xX-])\](?:[ \t]+|$)(.*)$/.exec(list[3]);
      if (task) {
        style.listStyle = task[1] === '-' ? 'task-choice' : 'task';
        if (task[1] !== ' ') style.taskState = task[1] === '-' ? 'cancelled' : 'done';
      }
      const text = task ? task[2] : list[3];
      if (!text) body.push({...style, runs:[]});
      else addTextBlocks(body, text, style, scope);
      continue;
    }
    if (kind !== 'paragraph') flush();
    indents.length = 0; pending.push(line);
  }
  flush();
  return body;
}

export function parseImportedNotes(source) {
  const files = (source.files || []).filter(file => markdown.test(file.path) || dataFile.test(file.path));
  const notes = referenceIndex(files, markdown);
  const images = referenceIndex((source.images || []).filter(image => raster.test(image.src)));
  const budget = {remaining:imageBudget};
  return files.map(({path, text}) => {
    const data = dataFile.exec(path);
    if (data) {
      return {path, title:fileName(path).replace(dataFile, ''), type:'data', dataText:text,
        dataLanguage:data[1].toLowerCase(), dataHasHeader:true, body:[], plain:'', weight:0, tags:[], links:[]};
    }
    const lines = text.replace(/^\uFEFF/, '').split(/\r\n?|\n/);
    const meta = splitFrontMatter(lines);
    const scope = {path, notes, images, budget, links:new Set(), omittedImages:0};
    const title = meta.title || fileName(path).replace(markdown, '');
    const body = parseBlocks(lines, meta.start, scope);
    const existing = new Set(noteTags(title, body.map(block => blockTagText(block)).join('\n')));
    const tags = [...new Set(meta.tags.map(tag => tag.toLowerCase()))].filter(tag => !existing.has(tag));
    if (meta.other) body.unshift({type:'code', language:'yaml', text:meta.other});
    if (tags.length) body.unshift({type:'paragraph', runs:[{text:tags.map(tag => '#' + tag).join(' ')}]});
    if (!body.length) body.push({type:'paragraph', runs:[]});
    const plain = richPlain(body);
    const weight = plain.length + 300 * body.filter(block => block.type === 'image').length;
    return {path, title, body, plain, weight, tags:[...existing, ...tags], links:[...scope.links], omittedImages:scope.omittedImages};
  });
}
