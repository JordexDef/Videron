import assert from 'node:assert/strict';
import test from 'node:test';
import {createNote, newLibrary, readLibrary, serializeLibrary} from '../frontend/data.js';
import {createQuickEntry, quickNotePatch} from '../frontend/quick-note.js';
import {searchTarget} from '../frontend/search-location.js';

test('new quick entries preserve multiline text, identity, order and search locations across saves', () => {
  const note = createNote(0, 0, null, 'quick');
  assert.equal(note.type, 'quick');
  assert.equal(createQuickEntry('  \r\n  '), null);
  const first = createQuickEntry('Список\r\nдел #дом', {id:'first', created:1});
  const second = createQuickEntry(' New #task ', {id:'second', created:2});
  first.runs[0].bold = true;
  Object.assign(note, quickNotePatch('Inbox', [second, first]));
  assert.equal(note.plain, 'New #task\nСписок\nдел #дом');
  assert.deepEqual(note.tags, ['task', 'дом']);
  const library = newLibrary();
  library.spaces.personal.notes.push(note);
  const reopened = readLibrary(serializeLibrary(library)).spaces.personal.notes[0];
  assert.deepEqual(reopened.body.map(({id, created}) => [id, created]), [['second', 2], ['first', 1]]);
  assert.equal(reopened.body[1].runs[0].bold, true);
  const index = note.plain.indexOf('дел');
  assert.deepEqual(searchTarget(reopened, {field:'body',start:index,end:index+3}),
    {kind:'body',ranges:[{index:1,start:7,end:10}]});
});
