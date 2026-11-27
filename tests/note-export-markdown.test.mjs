import assert from 'node:assert/strict';
import test from 'node:test';
import {setLanguage} from '../frontend/i18n.js';
import {buildMarkdownExport, markdownExportCounts} from '../frontend/note-export-markdown.js';
import {parseImportedNotes} from '../frontend/note-import-markdown.js';

setLanguage('en');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY+QAAAAASUVORK5CYII=';
const paragraph = text => ({type:'paragraph', runs:[{text}]});
const note = (id, title, options = {}) => ({id, title, body:[], tags:[], links:[], ...options});

test('export round-trips nested notes, relative cross-links, Unicode and shared raster attachments', () => {
  const space = {areas:[
    {id:'nested', name:'Исследования #1', parentId:'main'},
    {id:'main', name:'Projects'},
    {id:'empty', name:'Drafts', parentId:'main'},
  ], notes:[
    note('a', 'First note', {areaId:'nested', tags:['works/in-progress'], links:['b', 'b'], body:[
      {type:'heading', runs:[{text:'Hello'}]},
      paragraph('Text of the note'),
      {type:'image', src:png, alt:'Bright photo.png'},
    ]}),
    note('b', 'Русский #2 (инструменты)', {links:['a'], body:[{type:'image', src:png, alt:'other.png'}]}),
  ]};
  const before = JSON.stringify(space);
  const bundle = buildMarkdownExport(space);
  assert.deepEqual(bundle.directories, ['Projects', 'Projects/Исследования 1', 'Projects/Drafts']);
  const files = bundle.files.filter(entry => Object.hasOwn(entry, 'text'));
  const images = bundle.files.filter(entry => Object.hasOwn(entry, 'src'));
  assert.deepEqual(images, [{path:'_attachments/Bright photo.png', src:png}]);
  assert.match(files[0].text, /!\[Bright photo\.png\]\(\.\.\/\.\.\/_attachments\/Bright%20photo\.png\)/);
  assert.match(files[1].text, /\(\.\/Projects\/%D0%98[^)]+%201\/First%20note\.md\)/);
  assert.deepEqual(bundle.summary, {notes:2, skippedProtected:0, redactedCredentials:0, images:1, skippedImages:0, omittedDrawings:0});
  const imported = parseImportedNotes({files, images});
  assert.deepEqual(imported[0].links, [files[1].path]);
  assert.deepEqual(imported[1].links, [files[0].path]);
  assert.equal(imported[1].title, space.notes[1].title);
  assert.deepEqual(imported[0].tags, ['works/in-progress']);
  assert.equal(imported[0].body.find(block => block.type === 'image').src, png);
  assert.equal(JSON.stringify(space), before);
});

test('export allocates portable and independent paths for folders and conflicting note titles', () => {
  const areas = [
    {id:'a', name:'_ATTACHMENTS'}, {id:'b', name:'AUX.txt'}, {id:'c', name:'Café'}, {id:'d', name:'Cafe\u0301'},
    {id:'e', name:'topic.md'}, {id:'f', name:'CLOCK$.folder'}, {id:'g', name:'LPT0 .folder'},
  ];
  const notes = [note('1', 'topic'), note('2', 'TopiC'), note('3', 'COM¹.log '), note('4', '../bad/file?'),
    note('5', '😀'.repeat(96)), note('6', '😀'.repeat(95))];
  const bundle = buildMarkdownExport({areas, notes});
  assert.deepEqual(bundle.directories, ['_ATTACHMENTS (2)', '_AUX.txt', 'Café', 'Café (2)', 'topic.md', '_CLOCK$.folder', '_LPT0 .folder']);
  const paths = bundle.files.map(file => file.path);
  assert.deepEqual(paths.slice(0, 4), ['topic (2).md', 'TopiC (3).md', '_COM¹.log.md', 'bad file.md']);
  assert.notEqual(paths[4], paths[5]);
  assert.ok(paths.every(path => new TextEncoder().encode(path).length <= 120));
  assert.equal(parseImportedNotes({files:bundle.files})[4].title, notes[4].title);
});

test('individually sealed records and credential secrets stay out of the manifest', () => {
  const publicNote = note('public', 'Public', {links:['locked', 'missing'], body:[
    {type:'credentials', entries:[{resource:'private-service', login:'private-login', password:'private-pass'}]},
    {type:'paragraph', runs:[{text:'Folder label', folderPath:'C:\\Private\\Destination'},
      {text:' Suspicious link', href:'javascript:secretJS()'}, {text:' Normal link', href:'https://example.com'}]},
    {type:'image', src:'https://private-site/image.png', alt:'Remote image'},
    {type:'image', src:'data:image/png;base64,not-a-valid-image', alt:'Invalid Base64'},
    {type:'image', src:png.replace('image/png', 'image/gif'), alt:'Mislabelled image'},
  ]});
  const sealed = note('locked', 'Private title', {mapLabel:'Private alias', sealed:'ciphertext', body:[paragraph('Decrypted content')]});
  const space = {areas:[], notes:[publicNote, sealed]};
  assert.deepEqual(markdownExportCounts(space), {notes:1, skippedProtected:1, redactedCredentials:1});
  const bundle = buildMarkdownExport(space);
  assert.equal(bundle.summary.skippedImages, 3);
  assert.equal(bundle.files.length, 1);
  const exported = JSON.stringify(bundle);
  assert.doesNotMatch(exported, /Private title|Private alias|ciphertext|Decrypted content|private-service|private-login|private-pass|Destination|javascript:|secretJS|https:\/\/private-site|Linked notes/);
  assert.match(exported, /Credentials omitted/);
  assert.match(exported, /https:\/\/example\.com\//);
});

test('export retains ordinary formatting, code fences, canvas images, and spreadsheet values', () => {
  const text = note('text', 'Text', {body:[
    {type:'paragraph', runs:[{text:'bold', bold:true},{text:' and '},{text:'italic', italic:true}]},
    {type:'paragraph', listStyle:'task', taskState:'done', runs:[{text:'Complete'}]},
    {type:'paragraph', listStyle:'task-choice', taskState:'cancelled', indent:1, runs:[{text:'Cancelled'}]},
    {type:'code', language:'markdown', text:'```\nExample\n```'},
    paragraph('<script>alert(1)</script>'),
  ]});
  const canvas = note('canvas', 'Canvas', {type:'canvas', board:{elements:[
    {id:'diagram', type:'rect', label:'Rectangle label'},
    {id:'rich', type:'text', body:[paragraph('Formatted text'),{type:'image', src:png, alt:'A sample'}]},
    {id:'table', type:'table', name:'Numbers', rows:2, cols:2, headerRows:[0], cells:{A1:'Input', B1:'Double', A2:'5', B2:'=A2*2'}},
  ]}});
  const data = note('data', 'CSV', {type:'data', dataLanguage:'csv', dataText:'x,y\n1,2\n'});
  const bundle = buildMarkdownExport({areas:[], notes:[text, canvas, data]});
  const [, , canvasFile, dataFile] = bundle.files;
  assert.match(bundle.files[0].text, /\*\*bold\*\* and \*italic\*/);
  assert.match(bundle.files[0].text, /- \[x\] Complete\n {4}- \[-\] Cancelled/);
  assert.match(bundle.files[0].text, /````markdown\n```\nExample\n```\n````/);
  assert.doesNotMatch(bundle.files[0].text, /(?<!\\)<script>/);
  assert.match(canvasFile.text, /Rectangle label/);
  assert.match(canvasFile.text, /!\[A sample\]\(\.\/_attachments\/A%20sample\.png\)/);
  assert.match(canvasFile.text, /\| Input \| Double \|\n\| --- \| --- \|\n\| 5 \| 10 \|/);
  assert.equal(bundle.summary.omittedDrawings, 1);
  assert.match(dataFile.text, /```csv\nx,y\n1,2\n```/);
});
