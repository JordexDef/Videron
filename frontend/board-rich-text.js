const paragraphs = new Set(['paragraph', 'heading', 'subheading', 'quote']);
const raster = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i;

// Omitted colors follow the canvas theme, including on text areas saved by 0.17.
export function richFrameStyle(source) {
  const style = {};
  for (const key of ['frameBackground', 'frameBorder']) {
    const color = source[key];
    if (color === 'none' || typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)) style[key] = color;
  }
  return style;
}

export function richBlocks(body, { localFolders = true } = {}) {
  const blocks = [];
  for (const block of body) {
    if (paragraphs.has(block?.type)) {
      const runs = [];
      for (const run of Array.isArray(block.runs) ? block.runs : []) {
        if (typeof run?.text !== 'string') continue;
        if (localFolders || !run.folderPath) runs.push(run);
        else {
          const { folderPath, ...label } = run;
          runs.push(label);
        }
      }
      blocks.push({ ...block, runs });
    } else if (block?.type === 'divider') {
      blocks.push({ type: 'divider' });
    } else if (block?.type === 'code') {
      blocks.push({ ...block, text: String(block.text ?? '') });
    } else if (block?.type === 'image' && typeof block.src === 'string' && raster.test(block.src)) {
      blocks.push({ ...block, alt: String(block.alt ?? '') });
    }
  }
  return blocks.length ? blocks : [{ type: 'paragraph', runs: [] }];
}

export function richBlockText(block) {
  if (block.type === 'divider') return '';
  if (block.type === 'image') return block.alt;
  if (block.type === 'code') return block.text;
  return block.runs.map(run => run.text).join('');
}

export function richPlain(body) {
  return body.map(richBlockText).join('\n');
}

export function blockTagText(block, fallback = '') {
  if (block.type === 'code') return '';
  if (Array.isArray(block.runs))
    return block.runs.map(run => run.href || run.folderPath ? ' ' : run.text).join('');
  return block.alt || fallback;
}
