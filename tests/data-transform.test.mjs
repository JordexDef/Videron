import assert from 'node:assert/strict';
import test from 'node:test';
import { transformRows } from '../frontend/data-transform-worker.js';
import { transformDataLines } from '../frontend/data-transform.js';

test('line sort uses the chosen locale, orders numeric fragments naturally and preserves equal keys',()=>{
  const value='файл10\r\nфайл2\r\nфайл02\r\nфайл1\r\n';
  assert.equal(transformRows(value,'sort-asc','ru'),'файл1\r\nфайл2\r\nфайл02\r\nфайл10\r\n');
  assert.equal(transformRows(value,'sort-desc','ru'),'файл10\r\nфайл2\r\nфайл02\r\nфайл1\r\n');
  assert.equal(transformRows('c\r\nb\ra\n','sort-asc','en'),'a\r\nb\rc\n');
});

test('deduplication keeps first occurrences, including significant spaces and empty records',()=>{
  assert.equal(transformRows(' a\na\na\n a\n\n\n','unique'),' a\na\n\n');
  assert.equal(transformRows('a\r\nb\nc\ra','unique'),'a\r\nb\nc');
  assert.equal(transformRows('a\r\nb\na\rc\n','unique'),'a\r\nb\nc\n');
  assert.equal(transformRows('\n\n','unique'),'\n');
});

test('trimming and filtering support mixed line endings and do not invent a trailing line',()=>{
  assert.equal(transformRows(' a \r\n\t\nb\r c  ','trim'),'a\r\n\nb\rc');
  assert.equal(transformRows(' \r\n\t\r a \n  ','remove-empty'),' a ');
  assert.equal(transformRows('\rfirst\r\rlast\r','remove-empty'),'first\rlast\r');
  for (const operation of ['trim','remove-empty','unique','sort-asc','sort-desc']) {
    assert.equal(transformRows('',operation),'');
  }
  assert.equal(transformRows('\r\n\t\n \r','remove-empty'),'');
  assert.throws(()=>transformRows('abc','typo'),RangeError);
});

test('an already-aborted operation does not need to start a worker',async()=>{
  await assert.rejects(transformDataLines('b\na','sort-asc',{signal:AbortSignal.abort()}),{name:'AbortError'});
});

test('mixed-EOL transforms keep empty records when a CR would otherwise join an LF',() => {
  assert.equal(transformRows('a\r  \nb','trim'),'a\r\r\nb');
  assert.equal(transformRows('a\ra\n\nb','unique'),'a\r\r\nb');
  assert.equal(transformRows('\ra\n\nb','sort-asc'),'\r\r\na\nb');
});

test('an unresponsive worker can be replaced before sending document contents',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const starts=[], sent=[];
  const original=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  t.after(()=>{if(original)Object.defineProperty(globalThis,'Worker',original);else delete globalThis.Worker});
  globalThis.Worker=class {
    constructor(url){
      starts.push(this);
      if(String(url).startsWith('blob:'))queueMicrotask(()=>this.onmessage({data:{ready:true}}));
    }
    postMessage({text,operation}){
      sent.push(text);
      this.onmessage({data:{result:transformRows(text,operation)}});
    }
    terminate(){this.stopped=true}
  };
  const result=transformDataLines('a\na','unique');
  assert.deepEqual(sent,[]);
  t.mock.timers.tick(4000);
  assert.equal(await result,'a');
  assert.deepEqual(sent,['a\na']);
  assert.equal(starts.length,2);
  assert.ok(starts.every(worker=>worker.stopped));
});

test('large numbered columns agree with stable locale sort, including fallback for text or long IDs',()=>{
  const compare=new Intl.Collator('ru',{numeric:true}).compare;
  const rows=Array.from({length:10000},(_,i)=>'заказ-'+(i%3?'0':'')+((i*29)%379));
  for(const operation of ['sort-asc','sort-desc']){
    const sorted=[...rows].sort(operation==='sort-asc'?compare:(a,b)=>compare(b,a));
    assert.equal(transformRows(rows.join('\r'),operation,'ru'),sorted.join('\r'));
  }
  rows[921]='заказ-12345678901234567890';
  rows[84]='ложка';
  assert.equal(transformRows(rows.join('\n'),'sort-asc','ru'),[...rows].sort(compare).join('\n'));
});
