import { blockTagText } from './board-rich-text.js';

export const boardShapes = new Set(['rect', 'ellipse', 'diamond']);

export function boardElementText(element) {
  switch (element.type) {
    case 'table': return [element.name, ...Object.values(element.cells || {})].join('\n');
    case 'text': return element.text;
    case 'image': return element.alt;
    default: return boardShapes.has(element.type) ? element.label : '';
  }
}

export function boardSummary(input) {
  const source = input?.board ?? input;
  const elements = source?.elements || [];
  const parts = elements.map(boardElementText);
  const plain = parts.filter(Boolean).join('\n');
  const tagText = elements.map((element, i) => element.type === 'text' && Array.isArray(element.body)
    ? element.body.map(block => blockTagText(block)).join('\n')
    : parts[i]).filter(Boolean).join('\n');
  const weight = elements.reduce(
    (n, e) => n + (e.type === 'image' ? 300 : e.type === 'pen' ? 16 + (e.points?.length || 0) / 5 : 32),
    plain.length
  );
  return { plain, tagText, weight: Math.round(weight + (source?.strokes?.length || 0) * 8) };
}
