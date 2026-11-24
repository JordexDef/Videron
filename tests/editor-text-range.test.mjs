import test from 'node:test'
import assert from 'node:assert/strict'
import {moveTextRange,selectedBlocks} from '../frontend/editor-text-range.js'
import {blockText} from '../frontend/search-location.js'

const paragraph=text=>({type:'paragraph',runs:text?[{text}]:[]})
const point=(index,offset)=>({index,offset})
const textOf=blocks=>blocks.map(blockText).join('\n')

test('text moves at every paragraph boundary match one cut and one insertion',()=>{
  const body=['abc','','xyz','de'].map(paragraph), text=textOf(body), points=[]
  for(const [index,block] of body.entries()){
    for(let offset=0;offset<=blockText(block).length;offset++)points.push(point(index,offset))
  }
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)for(let k=0;k<points.length;k++){
    const range={start:points[i],end:points[j]}, target=points[k]
    const result=moveTextRange(body,range,target)
    if(k>=i && k<=j){assert.equal(result,null);continue}
    const cut=text.slice(0,i)+text.slice(j), moved=text.slice(i,j), pos=k<i?k:k-(j-i)
    assert.equal(textOf(result.body),cut.slice(0,pos)+moved+cut.slice(pos))
    assert.equal(textOf(selectedBlocks(result.body,result)),moved)
  }
  assert.equal(textOf(body),text)
})

test('moving across list items preserves links, task state, rich runs and unrelated blocks',()=>{
  const media={type:'image',alt:'outside'}
  const body=[{...paragraph('first'),listStyle:'bullet'},{
    type:'paragraph',listStyle:'task',taskState:'done',runs:[{text:'second',href:'https://example.org'}],
  },{type:'heading',runs:[{text:'third',bold:true}]},media,paragraph('beforeafter')]
  const moved=moveTextRange(body,{start:point(0,1),end:point(2,2)},point(4,6))
  assert.equal(moved.body[1],media)
  assert.deepEqual(moved.body[3],body[1])
  assert.deepEqual(moved.body[4].runs,[{text:'th',bold:true},{text:'after'}])
  assert.deepEqual(moved.body[0].runs,[{text:'f'},{text:'ird',bold:true}])
  assert.equal(moveTextRange(body,{start:point(2,2),end:point(4,2)},point(0,1)),null)
})
