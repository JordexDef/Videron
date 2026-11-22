import assert from 'node:assert/strict';
import test from 'node:test';
import {createDelimitedIndex} from '../frontend/delimited-engine.js';

const sort = (column, direction='asc', header=false) => ({kind:'sort',column,direction,header,language:'en'});
const unique = (columns, header=false) => ({kind:'unique',columns,header});

test('quoted fields, multiline records, escaped quotes and ragged rows have raw UTF-16 ranges', () => {
  const source='\uFEFFname,details,🧪\r\nalpha,"one, two\r\n""three""",x\nlast,\r';
  const table=createDelimitedIndex(source,',');
  assert.deepEqual([table.rowCount,table.columnCount],[3,3]);
  assert.deepEqual(table.read(0,3,0,3),[['name','details','🧪'],['alpha','one, two\r\n"three"','x'],['last','','']]);
  assert.deepEqual(table.read(1,100,1,1),[['one, two\r\n"three"'],['']]);
  for(const [row,col,raw] of [[0,0,'name'],[0,2,'🧪'],[1,1,'"one, two\r\n""three"""'],[2,1,''],[2,2,'']]){
    const {from,to}=table.cellRange(row,col);
    assert.equal(source.slice(from,to),raw);
  }
  assert.deepEqual(table.cellRange(2,2),{from:source.length-1,to:source.length-1});
});

test('empty documents, blank records, trailing fields and malformed quotes remain distinct', () => {
  for(const [input,rows,cols] of [['',0,0],['\uFEFF',0,0],['\n',1,1],['\n\n',2,1],[',',1,2],[',\r\n',1,2]]){
    const table=createDelimitedIndex(input,',');
    assert.deepEqual([table.rowCount,table.columnCount],[rows,cols]);
  }
  for(const [source,row,offset] of [['h\n"oops',2,7],['ok\r\n"a"x',2,7],['ab"cd',1,2]]){
    assert.throws(()=>createDelimitedIndex(source,','),error=>error.code==='MALFORMED' && error.row===row && error.offset===offset);
  }
});

test('sort keeps header, original quoting, ties and trailing newline while using numeric column values',()=>{
  const source='\uFEFFlabel\tvalue\r\n"second"\t02\rfirst\t-1.5\nthird\t2\r\nsmall\t0.01\n';
  const table=createDelimitedIndex(source,'\t');
  assert.deepEqual(table.transform(sort(1,'asc',true)),{
    text:'\uFEFFlabel\tvalue\r\nfirst\t-1.5\rsmall\t0.01\n"second"\t02\r\nthird\t2\n',rowCount:5,removed:0
  });
  assert.equal(table.transform(sort(1,'desc',true)).text,'\uFEFFlabel\tvalue\r\n"second"\t02\rthird\t2\nsmall\t0.01\r\nfirst\t-1.5\n');
  assert.equal(createDelimitedIndex('x1\nx2\nx02\nx10',',').transform(sort(0)).text,null);
});

test('deduplication compares exact decoded tuples, keeps first occurrence and ignores header',()=>{
  const source='a,b,c\r\n"ab",c,first\na,bc,second\rab,"c",removed\na,c,third\na,bc,removed\n"a\nb",c,fourth';
  const table=createDelimitedIndex(source,',');
  assert.deepEqual(table.transform(unique([1,0,1],true)),{
    text:'a,b,c\r\n"ab",c,first\na,bc,second\ra,c,third\n"a\nb",c,fourth',rowCount:5,removed:2
  });
  assert.deepEqual(createDelimitedIndex('x,x\nx,x\nx,"x"',',').transform(unique([0,1],true)),
    {text:'x,x\nx,x',rowCount:2,removed:1});
  assert.deepEqual(createDelimitedIndex('x,\nx',',').transform(unique([1])),{text:'x,',rowCount:1,removed:1});
  assert.throws(()=>table.transform(unique([])),RangeError);
  assert.throws(()=>table.transform(sort(3)),RangeError);
});

test('signed, decimal and exponent numbers sort exactly, with empty or missing values last',()=>{
  const source='h,k\nA,-3\nB,-10000000000000001\nC,9007199254740993\nD,-2\nE,9007199254740992\nF,""\nG\nH,9e-10000\nI,-1e-9999\nJ,0\nK,100e600\nL,1e603\nM,90.07199254740993e14\nN,.03';
  const result=createDelimitedIndex(source,',').transform(sort(1,'asc',true));
  const table=createDelimitedIndex(result.text,',');
  const ids=table.read(1,20,0,1).map(row=>row[0]);
  assert.deepEqual(ids,['B','A','D','I','J','H','N','E','C','M','K','L','F','G']);
  const down=table.transform(sort(1,'desc',true));
  assert.deepEqual(createDelimitedIndex(down.text,',').read(1,20,0,1).map(row=>row[0]),
    ['L','K','C','M','E','N','H','J','I','D','A','B','F','G']);
});

test('cell previews are bounded after decoding escaped quotes even inside a large field',()=>{
  const text='"'+'a""b'.repeat(200000)+'",two';
  const table=createDelimitedIndex(text,',');
  assert.deepEqual(table.read(0,1,0,2,4),[['a"ba','two']]);
  assert.deepEqual(table.cellRange(0,0),{from:0,to:text.length-4});
});

test('a blank final row and a CR/LF pair cannot silently disappear during serialization',()=>{
  const table=createDelimitedIndex('\nx',',');
  const sorted=table.transform(sort(0,'desc')).text;
  assert.equal(sorted,'x\n""');
  assert.deepEqual(createDelimitedIndex(sorted,',').read(0,2),[['x'],['']]);
  const filtered=createDelimitedIndex('b\rb\r\n\nc',',').transform(unique([0])).text;
  assert.equal(filtered,'b\r""\nc');
  assert.deepEqual(createDelimitedIndex(filtered,',').read(0,3),[['b'],[''],['c']]);
});

test('natural order uses stable locale ranks for category columns and exact distinct text keys',()=>{
  const keys=['I10','I2','i2','4','Пример','項目2','é','e\u0301','ß'];
  const data=Array.from({length:550},(_,i)=>[keys[(i*17)%keys.length],String(i)]);
  const source=data.map(row=>row.join(',')).join('\n');
  const table=createDelimitedIndex(source,',');
  const collate=new Intl.Collator('en',{numeric:true}).compare;
  const expected=[...data].sort((a,b)=>collate(a[0],b[0]));
  assert.deepEqual(createDelimitedIndex(table.transform(sort(0)).text,',').read(0,550),expected);
  assert.equal(table.transform(unique([0])).rowCount,keys.length);
});
