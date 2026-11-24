import test from 'node:test';
import assert from 'node:assert/strict';
import {applyExtensionNoteRequest} from '../frontend/extension-notes.js';
import {blankWorkspace, createNote, newLibrary, readLibrary, serializeLibrary} from '../frontend/data.js';

test('create writes a normal note at the host position and persists literal text and tags', () => {
  const library = newLibrary(), space = library.spaces.personal, changed = [];
  const result = applyExtensionNoteRequest(space, 'notes.create', {
    title:'Ideas #Plan', text:'<b>#One</b>\r\n\rEnd',
  }, {position:{x:18,y:-42}, onChange:n => changed.push(n)});
  const [note] = space.notes;
  assert.deepEqual(changed, [note]);
  assert.deepEqual(result, {id:note.id});
  assert.deepEqual([note.x, note.y], [18, -42]);
  assert.deepEqual(note.tags, ['plan','one']);
  assert.deepEqual(note.body, [
    {type:'paragraph', runs:[{text:'<b>#One</b>'}]},
    {type:'paragraph', runs:[]},
    {type:'paragraph', runs:[{text:'End'}]},
  ]);
  const saved = readLibrary(serializeLibrary(library)).spaces.personal.notes[0];
  assert.equal(saved.plain, '<b>#One</b>\n\nEnd');
  assert.equal(saved.weight, saved.plain.length);
});

test('append preserves structured content, indexed tags, styling, media weight, and relationships', () => {
  const blocks = [
    {type:'heading', runs:[{text:'#Title',bold:true}]},
    {type:'image', src:'data:image/png;base64,AA=='},
    {type:'code', text:'#Code'},
  ];
  const before = '#Title\n\n#Code';
  const note = {...createNote(1,2), title:'Data', body:blocks, plain:before, weight:before.length+300,
    modified:0, tags:['title'], links:['peer'], areaId:'area'};
  const space = {notes:[note]}, changed = [];
  const receipt = applyExtensionNoteRequest(space, 'notes.append', {text:'#New\r\nNext'}, {noteId:note.id,onChange:n => changed.push(n)});
  assert.deepEqual(receipt, {id:note.id});
  assert.equal(note.plain, before + '\n#New\nNext');
  assert.deepEqual(note.body.slice(0,3), blocks);
  assert.deepEqual(note.body[3], {type:'paragraph', runs:[{text:'#New'}]});
  assert.equal(note.weight, note.plain.length + 300);
  assert.deepEqual(note.tags, ['title','new']);
  assert.deepEqual(note.links, ['peer']);
  assert.equal(note.areaId, 'area');
  assert.ok(note.modified > 0);
  assert.deepEqual(changed, [note]);
});

test('append materializes legacy text and replaces a pristine empty paragraph', () => {
  const note = {...createNote(0,0), plain:'#Old\nLine 2'};
  const space = {notes:[note]}, context = {noteId:note.id, onChange() {}};
  applyExtensionNoteRequest(space, 'notes.append', {text:'Line 3'}, context);
  assert.deepEqual(note.body.map(b => b.runs[0].text), ['#Old','Line 2','Line 3']);
  assert.equal(note.plain, '#Old\nLine 2\nLine 3');
  assert.equal(note.weight, note.plain.length);
  assert.deepEqual(note.tags, ['old']);

  const empty = {...createNote(0,0), body:[{type:'paragraph', runs:[]}]};
  applyExtensionNoteRequest({notes:[empty]}, 'notes.append', {text:'First'}, {...context,noteId:empty.id});
  assert.equal(empty.plain, 'First');
  assert.equal(empty.body.length, 1);
});

test('reading exports only the selected text, full data document or canvas summary', () => {
  const space = blankWorkspace();
  for (const [type, text] of [['text','Summary'],['data','CSV\r\n1'],['canvas','Label']]) {
    const note = createNote(0,0,null,type);
    Object.assign(note, {title:'My note', plain:type === 'data' ? 'CSV' : text});
    if (type === 'data') note.dataText = text;
    space.notes.push(note);
    assert.deepEqual(applyExtensionNoteRequest(space,'notes.read',{}, {noteId:note.id}), {
      id:note.id, title:'My note', type, text,
    });
    if (type !== 'text') assert.throws(() => applyExtensionNoteRequest(space,'notes.append',{text:'wrong type'},{
      noteId:note.id, onChange:assert.fail,
    }));
  }
});

test('current host selection controls access and sealed notes stay inaccessible', () => {
  const visible = createNote(0,0);
  let privateReads = 0, writes = 0;
  const sealed = {id:'private',sealed:'envelope',get plain(){privateReads++;return 'private content'}};
  const space = {notes:[visible,sealed]};
  for (const [method,params] of [['notes.read',{}],['notes.append',{text:'new'}]]) {
    for (const noteId of [undefined, 'missing', sealed.id])
      assert.throws(() => applyExtensionNoteRequest(space,method,params,{noteId,onChange:() => writes++}));
    assert.throws(() => applyExtensionNoteRequest(space,method,{...params,id:sealed.id},{noteId:visible.id,onChange:() => writes++}));
  }
  assert.equal(privateReads, 0);
  assert.equal(writes, 0);
  assert.equal(visible.plain, '');
});

test('invalid or oversized inputs leave the workspace untouched', () => {
  const space = blankWorkspace(), context = {onChange:assert.fail};
  for (const params of [null, [], {title:1}, {title:'a'.repeat(513)}, {title:'x',text:false},
    {title:'x',text:'x'.repeat(256*1024+1)}, {title:'x',text:'\n'.repeat(4096)}, {title:'x',id:'chosen'}])
    assert.throws(() => applyExtensionNoteRequest(space,'notes.create',params,context));
  assert.deepEqual(space.notes, []);
  const note = {...createNote(0,0), plain:'q'.repeat(8*1024*1024+1)};
  assert.throws(() => applyExtensionNoteRequest({notes:[note]}, 'notes.read', {}, {noteId:note.id}));
});
