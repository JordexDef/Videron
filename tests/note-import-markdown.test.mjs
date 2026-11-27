import test from 'node:test';
import assert from 'node:assert/strict';
import {parseImportedNotes} from '../frontend/note-import-markdown.js';

const file = (path, text = '') => ({path, text});

test('converts basic Markdown and keeps front matter tags in the editable note', () => {
  const text = [
    '\uFEFF---', 'title: "Field notes"', 'tags:', '  - Hike', '  - notes/2026', 'author: "Ada"', '---',
    '', '# Overview', '**Strong** and _emphasis_. #hike #trail', '',
    '- [x] Packed', '    1) Bring a map', '    2) Draw the route', '- [ ] Return', '',
    '> Cite the [source](https://example.test/info "Notes").', '',
    '```js', '// [[Not a link]] #not-a-tag', 'console.log("kept")', '```',
    '', 'Text', '====', '', '***',
  ].join('\r\n');
  const [note] = parseImportedNotes({files:[file('Hikes/First.MD', text), file('Not a link.md')]});
  assert.equal(note.title, 'Field notes');
  assert.deepEqual(new Set(note.tags), new Set(['hike', 'trail', 'notes/2026']));
  assert.deepEqual(note.body.map(block => block.type), [
    'paragraph', 'code', 'heading', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'quote', 'code', 'heading', 'divider'
  ]);
  assert.equal(note.body[0].runs[0].text, '#notes/2026');
  assert.deepEqual(note.body[1], {type:'code', language:'yaml', text:'author: "Ada"'});
  assert.deepEqual(note.body[3].runs, [
    {text:'Strong', bold:true}, {text:' and '}, {text:'emphasis', italic:true}, {text:'. #hike #trail'}
  ]);
  assert.equal(note.body[4].taskState, 'done');
  assert.equal(note.body[5].listStyle, 'parenthesis');
  assert.equal(note.body[5].indent, 1);
  assert.equal(note.body[7].listStyle, 'task');
  assert.deepEqual(note.body[8].runs[1], {text:'source', href:'https://example.test/info'});
  assert.deepEqual(note.body[9], {type:'code', language:'javascript', text:'// [[Not a link]] #not-a-tag\nconsole.log("kept")'});
  assert.deepEqual(note.links, []);
  assert.ok(note.plain.includes('console.log'));
});

test('matches explicit paths and unique names, leaving ambiguous and missing links readable', () => {
  const notes = parseImportedNotes({files:[
    file('Journal/Today.md', [
      '[[Projects/One|First project]]', '[[Новая идея]]', '[small plan](./Small%20plan.markdown#Tasks)',
      '[numbers](../Figures/source.csv)', '[[Same]]', '[[Nobody]]', '[outside](../../Projects/One.md)',
      '[unsafe](javascript:alert(1))', '[round](../Projects/A%20(copy).md)', '[[Plan%20draft]]', '[[#Here]]'
    ].join('\n\n')),
    file('Projects/One.md'), file('Projects/Новая идея.md'), file('Journal/Small plan.markdown'),
    file('Projects/A (copy).md'), file('Plan%20draft.md'), file('Plan draft.md'), file('Desk/Same.md'), file('Archived/Same.markdown'),
    file('Figures/source.csv', 'Name,Number\r\nA,1\r\n'), file('Table.TSV', 'Name\tValue\nA\t1\n'),
    file('ignored.txt'),
  ]});
  const first = notes[0];
  assert.deepEqual(first.links, [
    'Projects/One.md', 'Projects/Новая идея.md', 'Journal/Small plan.markdown', 'Figures/source.csv', 'Projects/A (copy).md', 'Plan%20draft.md'
  ]);
  assert.match(first.plain, /First project\nНовая идея\nsmall plan\nnumbers/);
  assert.match(first.plain, /\[\[Same\]\]\n\[\[Nobody\]\]/);
  assert.match(first.plain, /\[outside\]\(\.\.\/\.\.\/Projects\/One\.md\)/);
  assert.ok(first.body.every(block => block.runs.every(run => !run.href)));
  const data = notes.filter(note => note.type === 'data');
  assert.deepEqual(data.map(note => [note.title, note.dataLanguage, note.dataHasHeader, note.dataText]), [
    ['source', 'csv', true, 'Name,Number\r\nA,1\r\n'],
    ['Table', 'tsv', true, 'Name\tValue\nA\t1\n']
  ]);
  assert.ok(!notes.some(note => note.path === 'ignored.txt'));
});

test('embeds only bundled raster attachments and retains unsupported references and HTML as text', () => {
  const png = 'data:image/png;base64,AA==';
  const notes = parseImportedNotes({files:[
    file('Notebook/Trip.md', [
      'Before ![[Postcard.png|100x150]] after',
      '[[_resources/plan.md]]',
      '![QR](../_resources/qrcode.png)',
      '![Remote](https://example.test/photo.png)',
      '![[poster.svg]]',
      '![[Referenced note]]',
      '<img src="https://example.test/track">',
    ].join('\n\n')),
    file('Referenced note.md'),
  ], images:[
    {path:'Attachments/Postcard.png', src:png},
    {path:'_resources/qrcode.png', src:png},
    {path:'_resources/poster.svg', src:'data:image/svg+xml;base64,AA=='},
  ]});
  const [note] = notes;
  assert.deepEqual(note.body.filter(block => block.type === 'image'), [
    {type:'image', alt:'Postcard.png', src:png}, {type:'image', alt:'QR', src:png}
  ]);
  assert.deepEqual(note.links, ['Referenced note.md']);
  assert.equal(note.omittedImages, 2);
  assert.match(note.plain, /!\[Remote\]\(https:\/\/example\.test\/photo\.png\)/);
  assert.match(note.plain, /<img src="https:\/\/example\.test\/track">/);
});

test('repeated embedded photos share an import budget and overflow remains readable', () => {
  const pattern = '![[photo.png]]';
  const [first, second] = parseImportedNotes({
    files:[file('First.md', [pattern, pattern].join('\n')), file('Second.md', [pattern, pattern].join('\n'))],
    images:[{path:'photo.png', src:'data:image/png;base64,' + 'A'.repeat(10 * 1024 * 1024)}],
  });
  assert.equal(first.body.filter(block => block.type === 'image').length, 2);
  assert.equal(second.body.filter(block => block.type === 'image').length, 1);
  assert.equal(second.omittedImages, 1);
  assert.ok(second.plain.endsWith(pattern));
});
