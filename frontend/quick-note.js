import {blockTagText, richPlain} from './board-rich-text.js';
import {noteTags} from './note-tags.js';

export function createQuickEntry(text, {id = crypto.randomUUID(), created = Date.now()} = {}) {
  const value = text.replace(/\r\n?/g, '\n').trim();
  return value ? {type:'paragraph', id, created, runs:[{text:value}]} : null;
}

export function quickNotePatch(title, body) {
  const plain = richPlain(body);
  return {title, bodyVersion:1, body, plain, tags:noteTags(title, body.map(block => blockTagText(block)).join('\n')), weight:plain.length};
}
