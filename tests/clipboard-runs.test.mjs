import test from 'node:test'
import assert from 'node:assert/strict'
import {readClipboardRuns} from '../frontend/clipboard-runs.js'

// The parser consumes just the inert node tree and the editor's mark filter.
const text = data => ({nodeType:3,data})
function node(tagName, ...children) {
  const childNodes = children.map(child=>typeof child === 'string' ? text(child) : child)
  return {tagName,nodeType:tagName?1:11,childNodes,firstChild:childNodes[0],style:{}}
}
const marks = (n, inherited) => n.tagName === 'B' ? {...inherited,bold:true}
  : n.tagName === 'I' ? {...inherited,italic:true} : inherited
const parse = (root, plain = null) => readClipboardRuns(root, plain, marks)
const all = runs => runs.map(run=>run.text).join('')

test('pasting one styled word ignores indentation around its paragraph', () => {
  const root = node(null,'\n',node('DIV','\n  ',node('P','\n ',node('B','1mu'),'\n'),'\n'),'\n')
  assert.deepEqual(parse(root,'1mu'),[{text:'1mu',bold:true}])
  assert.deepEqual(parse(root),[{text:'1mu',bold:true}])
})

test('block wrappers separate paragraphs once; explicit blank paragraphs and breaks survive', () => {
  const root = node(null,node('DIV',node('P','one'), '\n\t',
    node('P',node('BR')),'\n',node('SECTION',node('DIV','two',node('BR'),'three')),
    '\n\t',node('P','four',node('BR')),node('DIV','five')))
  assert.equal(all(parse(root)), 'one\n\ntwo\nthree\nfour\nfive')
  const blanks = node(null,node('P',node('BR')),node('P','x'),node('P',node('BR')))
  assert.equal(all(parse(blanks)), '\nx\n')
  assert.equal(all(parse(node(null,'a',node('BR'),node('BR'),'b'))), 'a\n\nb')
})

test('normal HTML whitespace collapses between spans and preformatted indentation stays literal', () => {
  const root = node(null,node('DIV','a',node('B',' one\n   two'),'\n\t ',node('I','three')),
    node('PRE','  x\r\n',node('B','    y'),'\n'))
  assert.equal(all(parse(root)),'a one two three\n  x\n    y\n')
  const span = node('SPAN','  alpha\n\n  beta '); span.style.whiteSpace='pre-wrap'
  assert.equal(all(parse(node(null,span))),'  alpha\n\n  beta ')
})

test('the plain representation restores selected spacing without unformatting its words', () => {
  const root = node(null,node('P',node('B','one')),node('P',node('I','two')))
  assert.deepEqual(parse(root,'one\r\n\r\n\r\ntwo'),[
    {text:'one',bold:true},{text:'\n\n\n'},{text:'two',italic:true}])
  assert.equal(all(parse(root, ' one\ttwo \r')), ' one\ttwo \n')
  assert.equal(all(parse(null, '  x\r\n\r\n  y  ')), '  x\n\n  y  ')
  assert.deepEqual(parse(node(null,node('B','one')), '**one**'),[{text:'one',bold:true}])
})

test('clipboard markup for scripts, page metadata and hidden content never becomes rich text', () => {
  const hidden = node('SPAN','do not show'); hidden.hidden=true
  const root = node(null,node('TITLE','page title'),node('STYLE','p {...}'),
    node('SCRIPT','hidden script'),hidden,node('B','shown'))
  assert.deepEqual(parse(root),[{text:'shown',bold:true}])
  assert.deepEqual(parse(node(null,node('STYLE','a{}')),'fallback'),[{text:'fallback'}])
  assert.deepEqual(parse(node(null,node('P',node('IMG')),node('P',node('BR'))),'picture caption'),[{text:'picture caption'}])
})
