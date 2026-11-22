import test from 'node:test';
import assert from 'node:assert/strict';
import { CODE_LANGUAGES, codeLanguage, detectCodeLanguage, formatJSON, highlightCode, indentCodeSelection } from '../frontend/code-block.js';

test('code indentation preserves selected text and leaves the next unselected line alone', () => {
  assert.deepEqual(indentCodeSelection('first\nsecond\nlast', 1, 13, false), {
    from:0, to:12, replacement:'\tfirst\n\tsecond', selectionStart:2, selectionEnd:15,
  });
  assert.deepEqual(indentCodeSelection('x\n\nlast', 2, 3, false), {
    from:2, to:2, replacement:'\t', selectionStart:2, selectionEnd:4,
  });
});

test('outdenting handles mixed tabs and spaces even when the selection ends in the indentation', () => {
  assert.deepEqual(indentCodeSelection('\tone\n    two\nlast', 1, 7, true), {
    from:0, to:12, replacement:'one\ntwo', selectionStart:0, selectionEnd:4,
  });
  assert.deepEqual(indentCodeSelection('abc\nlast', 0, 2, true), {
    from:0, to:3, replacement:'abc', selectionStart:0, selectionEnd:2,
  });
});

test('JSON formatting preserves number lexemes, duplicate keys, escape spelling and key order', () => {
  const text = String.raw`{"z":9007199254740993123456789,"z":-0.00e+08,"2":"\u0061","1":[{},[],{"path":"a\\b\/c"}]}`;
  const expected = String.raw`{
  "z": 9007199254740993123456789,
  "z": -0.00e+08,
  "2": "\u0061",
  "1": [
    {},
    [],
    {
      "path": "a\\b\/c"
    }
  ]
}`;
  assert.deepEqual(formatJSON(text), { ok: true, text: expected });
  assert.deepEqual(formatJSON(expected), { ok: true, text: expected });
  for (const primitive of ['false', 'null', 'true', '-0', '"{}"', '1E400']) {
    assert.deepEqual(formatJSON(' \t\r\n' + primitive), { ok: true, text: primitive });
  }
});

test('invalid JSON stays verbatim and reports a 1-based location across CRLF and Unicode', () => {
  const samples = [
    ['', 1, 1], ['{"x":}', 1, 6], ['[1,]', 1, 4], ['{"a":0,}', 1, 8],
    ['[1\r\n  2]', 2, 3], ['{"€😀":0 x}', 1, 9], ['[\r{', 2, 2],
    ['"bad\\u12X4"', 1, 9], ['"bad\\', 1, 6], ['"a\tb"', 1, 3],
    ['[}', 1, 2], ['[(1)]', 1, 2], ['00', 1, 2], ['true false', 1, 6],
    ['[1e]', 1, 3], ['{x: 1}', 1, 2], ['\u00a0{}', 1, 1]
  ];
  for (const [text, line, column] of samples) {
    assert.deepEqual(formatJSON(text), { ok: false, text, line, column }, text);
  }
});

test('deep JSON can be formatted without recursion or unbounded indentation growth', () => {
  const source = '['.repeat(600) + 'null' + ']'.repeat(600);
  const result = formatJSON(source);
  assert.ok(result.ok);
  assert.equal(result.text.replace(/\s/g, ''), source);
  assert.ok(result.text.length < 130000);
});

test('JSON syntax differentiates keys, string values, numbers and literals without altering text', () => {
  const text = String.raw`{"ключ":"<b>a\",b</b>","n":-1.5e2,"test":true}`;
  const tokens = highlightCode(text, 'auto');
  assert.equal(tokens.map(t => t.text).join(''), text);
  assert.deepEqual(tokens.filter(t => t.kind === 'key').map(t => t.text), ['"ключ"', '"n"', '"test"']);
  assert.equal(tokens.find(t => t.kind === 'string').text, String.raw`"<b>a\",b</b>"`);
  assert.equal(tokens.find(t => t.kind === 'number').text, '-1.5e2');
  assert.equal(tokens.find(t => t.kind === 'literal').text, 'true');
  assert.deepEqual(highlightCode(text, 'plain'), [{ kind: 'plain', text }]);
  assert.deepEqual(highlightCode('', 'json'), []);
});

test('script language aliases and conservative detection feed a lossless offline highlight', () => {
  const examples = [
    ['json', 'JSON', '{"hi": false}'], ['javascript', 'js', 'const a = "// literal"; // comment'],
    ['typescript', 'ts', 'interface Point { x: number; }'], ['go', 'golang', 'package main\nfunc main() {}'],
    ['rust', 'rs', 'fn main() { println!("hi"); }'], ['python', 'py', 'def hi():\n  print("hi") # comment'],
    ['powershell', 'ps1', 'Get-ChildItem # note'], ['shell', 'bash', '#!/bin/sh\nif true; then echo ok; fi'],
    ['yaml', 'yml', 'name: hello\nid: 2'], ['sql', 'sql', "SELECT id FROM files WHERE name = 'note'"],
    ['css', 'css', '.note { color: #aaa; }'], ['html', 'svg', '<svg><path fill="red"/></svg>']
  ];
  for (const [language, alias, source] of examples) {
    assert.equal(codeLanguage(alias), language);
    assert.equal(detectCodeLanguage(source), language);
    const tokens = highlightCode(source);
    assert.equal(tokens.map(t => t.text).join(''), source);
    assert.ok(tokens.some(t => t.kind !== 'plain'));
  }
  assert.equal(codeLanguage('unknown'), 'auto');
  assert.equal(detectCodeLanguage('Список покупок'), 'plain');
  const messy = '\r\n "</style>" # буква\t\u0000\\\n// end';
  for (const language of CODE_LANGUAGES)
    assert.equal(highlightCode(messy, language).map(t => t.text).join(''), messy);
});
