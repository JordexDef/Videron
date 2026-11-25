import test from 'node:test';
import assert from 'node:assert/strict';
import { findNoteMatches, replacementText, trackFindSelection } from '../frontend/note-find-matches.js';

const rows=[{id:'a',text:'Кот котёнок скот КОТ (кот) кот_1 кот́.'},{id:'code',text:'a.b A.B axb'}];
test('a saved search selection follows the edited position even among identical words',()=>{
  const rows=text=>[{id:'p',text}], range=[{id:'p',from:4,to:7}];
  const before=rows('fox fox'), after=rows('fox fox fox');
  assert.deepEqual(trackFindSelection(range,before,after,{id:'p',from:0,to:0,type:'insertText'}),[{id:'p',from:8,to:11}]);
  assert.deepEqual(trackFindSelection(range,before,after,{id:'p',from:7,to:7,type:'insertText'}),range);
  assert.deepEqual(trackFindSelection(range,before,rows('ox fox'),{id:'p',from:1,to:1,type:'deleteContentBackward'}),[{id:'p',from:3,to:6}]);
  assert.deepEqual(trackFindSelection(range,before,rows('fox fx'),{id:'p',from:5,to:5,type:'deleteContentForward'}),[{id:'p',from:4,to:6}]);
  assert.deepEqual(trackFindSelection(range,before,after,null),[]);
  assert.deepEqual(trackFindSelection(range,before,[...before,{id:'p2',text:'fox'}],null),[]);
  const empty=[{id:'empty-cell',from:0,to:0}];
  assert.deepEqual(trackFindSelection(empty,before,after,null),empty);
});
test('literal, case and Unicode whole-word matching keep native editor offsets',()=>{
  const matches=options=>findNoteMatches(rows,options).matches;
  assert.deepEqual(matches({query:'кот',wholeWord:true}).map(m=>[m.id,m.from,m.value]),
    [['a',0,'Кот'],['a',17,'КОТ'],['a',22,'кот']]);
  assert.deepEqual(matches({query:'a.b'}).map(m=>m.from),[0,4]);
  assert.deepEqual(matches({query:'a.b',matchCase:true}).map(m=>m.value),['a.b']);
  assert.equal(matches({query:''}).length,0);
});
test('regex matches expose numbered and named groups, empty matches advance across Unicode',()=>{
  const records=[{id:'r',text:'🍐 a-2 a-10'}];
  const opts={query:'(?<key>a)-(\\d+)',regex:true};
  const {matches}=findNoteMatches(records,opts);
  assert.deepEqual(matches.map(m=>replacementText(m,'$2:$<key> ($& $$ $0)',opts)),
    ['2:a (a-2 $ a-2)','10:a (a-10 $ a-10)']);
  assert.equal(replacementText(matches[0],'$10,$3',opts),'a0,$3');
  assert.equal(replacementText(matches[0],'$1\\t$2\\n\\\\n',opts),'a\t2\n\\n');
  assert.deepEqual(findNoteMatches(records,{regex:true,query:'(?=.)'}).matches.slice(0,2).map(m=>m.from),[0,2]);
  assert.equal(findNoteMatches(records,{regex:true,query:'('}).error,'syntax');
});
test('scoped search includes only entire matches and flags locked records',()=>{
  const records=[{id:'a',text:'slow slow slow'},{id:'b',text:'slow',readOnly:true}];
  const {matches}=findNoteMatches(records,{query:'slow'},[{id:'a',from:3,to:10},{id:'b',from:0,to:4}]);
  assert.deepEqual(matches.map(m=>[m.id,m.from,!!m.readOnly]),[['a',5,false],['b',0,true]]);
});
test('preserving case follows the matched text, literal replacements keep capture syntax verbatim',()=>{
  for(const [value,expected] of [['Кот','Лис'],['КОТ','ЛИС'],['кот','лис'],['кОт','лис'],['123','лис']])
    assert.equal(replacementText({value},'лис',{preserveCase:true}),expected);
  assert.equal(replacementText({value:'word'},'$$ $1 $&',{}),'$$ $1 $&');
});
