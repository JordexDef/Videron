import {normalizeBoard, renderBoardPreview} from './board.js';
import {noteWorkbooks} from './board-tables.js';
import {boardPaper} from './board-theme.js';
import {indentOf, listMarkers, taskStateOf} from './note-lists.js';
import {isProtectedNote} from './note-vault.js';
import {tr} from './i18n.js';

const raster = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i;

function fenced(text, language = '') {
  let length = 3;
  for (const match of text.matchAll(/`{3,}/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  const label = /^[\w+#.-]+$/.test(language) && language !== 'auto' ? language : '';
  return fence + label + '\n' + text + '\n' + fence;
}

function runText(run) {
  let text = run.text || '';
  if (run.bold) text = '**' + text + '**';
  if (run.italic) text = '*' + text + '*';
  if (run.underline) text = '<u>' + text + '</u>';
  if (typeof run.color === 'string' && /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(run.color))
    text = '<span style="color:' + run.color + '">' + text + '</span>';
  if (typeof run.href === 'string' && /^(https?:\/\/|mailto:)/i.test(run.href) && !run.folderPath)
    text = '[' + text + '](<' + run.href.replace(/[<>\s]/g, encodeURIComponent) + '>)';
  return text;
}

function noteContext(note) {
  if (!note || isProtectedNote(note))
    throw Error(tr('Сначала разблокируйте заметку.', 'Unlock the note first.'));

  const scenes = new Map(), books = noteWorkbooks(), images = [], drawings = [];
  function register(key, input) {
    const scene = normalizeBoard(input);
    books.register(key, scene.elements);
    scenes.set(key, scene);
  }

  function imageLabel(block) {
    const number = images.length + 1;
    const alt = block.alt || '';
    const label = 'Image ' + number + (alt ? ' — ' + alt : ' (no description)');
    images.push({label, src: typeof block.src === 'string' && raster.test(block.src) ? block.src : null});
    return label;
  }

  function sceneText(key) {
    const scene = scenes.get(key);
    const workbook = books.workbook(key, scene.elements);
    const objects = scene.elements.map(element => {
      // Each scene was normalized above. Export public diagram fields only; an element can
      // also carry a private local folder path, full binary image or rich editor document.
      const object = {};
      for (const field of ['id', 'type', 'x', 'y', 'w', 'h', 'angle', 'groupIds', 'locked', 'label',
        'stroke', 'fill', 'lineWidth', 'strokeStyle', 'fillStyle', 'roughness', 'rounded', 'labelColor',
        'points', 'pressures', 'strokeProfile', 'smoothPoints', 'startBinding', 'endBinding',
        'fontSize', 'textAlign', 'frameBorder', 'frameBackground', 'name', 'rows', 'cols', 'headerRows',
        'headerCols', 'showName', 'showRowNumbers', 'showColumnLetters', 'chartType', 'tableId', 'range']) {
        if (element[field] !== undefined) object[field] = element[field];
      }
      if (element.type === 'text') object.text = element.body ? blocksText(element.body) : element.text;
      if (element.type === 'image') object.image = imageLabel(element);
      if (element.type === 'table') {
        object.cells = Object.fromEntries(Object.entries(element.cells).map(([address, raw]) =>
          [address, raw.startsWith('=') ? {formula:raw, value:workbook.value(element.id, address)} : raw]));
      }
      return object;
    });
    const legend = 'Objects are ordered back to front. x/y are the top-left of the unrotated box, ' +
      'w/h its size, angle clockwise in degrees. Path points and binding u/v are fractions of the box.';
    let description = legend;
    if (objects.some(e => e.type === 'table'))
      description += ' Table header indices start at zero. Missing cell addresses are empty.';
    // One line per object keeps labels and cell addresses adjacent to their source objects.
    const lines = ['{', ...(scene.background ? ['"background":' + JSON.stringify(scene.background) + ','] : []),
      '"objects":[', objects.map(object => JSON.stringify(object)).join(',\n'), ']}'];
    let label = scene.elements.length ? 'Table' : 'Empty drawing';
    if (scene.elements.some(e => e.type !== 'table')) {
      label = 'Drawing ' + (drawings.length + 1);
      drawings.push({label, scene, workbook});
    }
    return label + '\n\n' + description + '\n\n' + fenced(lines.join('\n'), 'json');
  }

  function blocksText(blocks) {
    const markers = listMarkers(blocks);
    return blocks.map((block, index) => {
      let text;
      switch (block.type) {
        case 'credentials': text = '[Credentials omitted]'; break;
        case 'drawing': text = sceneText(block); break;
        case 'image': text = imageLabel(block); break;
        case 'code': text = fenced(String(block.text ?? ''), block.language); break;
        case 'divider': text = '---'; break;
        default: {
          text = (block.runs || []).map(runText).join('');
          if (block.type === 'heading') text = '## ' + text;
          if (block.type === 'subheading') text = '### ' + text;
          if (block.type === 'quote') text = '> ' + text.replace(/\n/g, '\n> ');
          if (markers[index]) {
            const state = taskStateOf(block);
            const marker = state === 'done' ? '- [x]' : state === 'pending' ? '- [ ]' :
              state === 'cancelled' ? '- [-] (cancelled)' : markers[index] === '•' ? '-' : markers[index];
            text = '  '.repeat(indentOf(block)) + marker + ' ' + text;
          }
        }
      }
      return (index === 0 ? '' : markers[index] && markers[index - 1] ? '\n' : '\n\n') + text;
    }).join('');
  }

  let content;
  if (note.type === 'data') {
    content = fenced(note.dataText ?? '', note.dataLanguage);
    if (['csv', 'tsv'].includes(note.dataLanguage))
      content = (note.dataHasHeader === false ? 'No header row.' : 'First row contains column names.') + '\n\n' + content;
  } else if (note.type === 'canvas') {
    register(note, note.board);
    content = sceneText(note);
  } else if (note.body?.length) {
    for (const block of note.body) if (block.type === 'drawing') register(block, block);
    content = blocksText(note.body);
  } else {
    content = note.plain || '';
  }
  const text = '# ' + (note.title || 'Untitled') + '\n\n' + content +
    (images.length ? '\n\nRaster pixels are omitted from this text. Rich paste can include the numbered images.' : '');
  return {text, images, drawings};
}

export function formatNoteForAI(note) {
  return noteContext(note).text;
}

const escapeHtml = text => text.replace(/[&<>"']/g, ch =>
  ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[ch]);

function imageFigure(label, src) {
  return '<figure><figcaption>' + escapeHtml(label) + '</figcaption><img alt="' + escapeHtml(label) +
    '" src="' + escapeHtml(src) + '"></figure>';
}

async function richClipboardBlob(text, images, drawings) {
  const parts = ['<pre>' + escapeHtml(text) + '</pre>'];
  for (const {label, src} of images) parts.push(imageFigure(label, src));
  for (const {label, scene, workbook} of drawings) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 640;
      // A drawing can reference a table in a different drawing within this note.
      // Use the note-wide results in the preview as well as the structured text.
      const elements = scene.elements.map(e => e.type !== 'table' ? e : {...e,
        cells:Object.fromEntries(Object.entries(e.cells).map(([addr, raw]) =>
          [addr, raw.startsWith('=') ? workbook.value(e.id, addr) : raw]))});
      await renderBoardPreview(canvas, {...scene, elements});
      const ctx = canvas.getContext('2d');
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = boardPaper(scene.background);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      parts.push(imageFigure(label, canvas.toDataURL('image/png')));
    } catch {
      // The structured drawing is still present if this webview cannot render a thumbnail.
    }
  }
  return new Blob(parts, {type:'text/html'});
}

export async function copyNoteForAI(note) {
  const {text, images, drawings} = noteContext(note);
  const clipboard = globalThis.navigator?.clipboard;
  const embedded = images.filter(image => image.src);
  if ((embedded.length || drawings.length) && clipboard?.write && globalThis.ClipboardItem) {
    try {
      const item = new ClipboardItem({'text/plain':new Blob([text], {type:'text/plain'}),
        'text/html':richClipboardBlob(text, embedded, drawings)});
      await clipboard.write([item]);
      return {images:images.length, embedded:embedded.length};
    } catch {
      // Some desktop webviews only expose the native text clipboard.
    }
  }
  const runtime = globalThis.window?.runtime;
  if (runtime?.ClipboardSetText) await runtime.ClipboardSetText(text);
  else if (clipboard?.writeText) await clipboard.writeText(text);
  else throw Error(tr('Буфер обмена недоступен.', 'Clipboard unavailable.'));
  return {images:images.length, embedded:0};
}
