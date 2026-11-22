// Every token is source text. The view supplies the colors and creates text nodes.
export const CODE_LANGUAGES = Object.freeze([
  'auto', 'json', 'javascript', 'typescript', 'python', 'powershell', 'go',
  'rust', 'html', 'css', 'shell', 'yaml', 'sql', 'plain'
]);

const aliases = new Map(Object.entries({
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', ps1: 'powershell', pwsh: 'powershell',
  golang: 'go', rs: 'rust', xml: 'html', svg: 'html', sh: 'shell', bash: 'shell',
  zsh: 'shell', yml: 'yaml', txt: 'plain', text: 'plain', plaintext: 'plain'
}));

export function codeLanguage(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return CODE_LANGUAGES.includes(id) ? id : aliases.get(id) ?? 'auto';
}

// A selection ending at the start of a line leaves that line untouched.
export function indentCodeSelection(text, start, end, outdent) {
  const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end - 1);
  const to = newline < 0 ? text.length : newline;
  let lineStart = from, selectionStart = start, selectionEnd = end;
  const lines = text.slice(from, to).split('\n').map(line => {
    const removed = outdent ? (/^\t|^ {1,4}/.exec(line)?.[0].length || 0) : 0;
    if (outdent) {
      selectionStart -= Math.max(0, Math.min(removed, start - lineStart));
      selectionEnd -= Math.max(0, Math.min(removed, end - lineStart));
    } else {
      if (lineStart < start) selectionStart++;
      selectionEnd++;
    }
    lineStart += line.length + 1;
    return outdent ? line.slice(removed) : '\t' + line;
  });
  return {from, to, replacement:lines.join('\n'), selectionStart, selectionEnd};
}

export function detectCodeLanguage(text) {
  const sample = text.slice(0, 4096).trimStart();
  if (/^(?:\{\s*(?:"|\}|$)|\[\s*(?:[\[\]{"\d-]|true\b|false\b|null\b|$))/.test(sample)) return 'json';
  if (/^<(?:!doctype\s+html|\?xml|!--|\/?[\w:-]+(?:\s|\/?>))/i.test(sample)) return 'html';
  if (/^#![^\r\n]*\b(?:bash|sh|zsh)\b/.test(sample)) return 'shell';
  if (/^#![^\r\n]*\bpython[\d.]*\b|^\s*(?:def\s+\w+\s*\(|from\s+\S+\s+import\s|import\s+\w+\s*$|print\s*\()/m.test(sample)) return 'python';
  if (/\b(?:package\s+\w+\s*$|func\s+\w+\s*\()/m.test(sample)) return 'go';
  if (/\b(?:fn\s+\w+\s*\(|use\s+\w+::|let\s+mut\s+\w+|println!\s*\()/.test(sample)) return 'rust';
  if (/^\s*(?:export\s+)?(?:interface\s+\w+|type\s+\w+\s*=|(?:const|let)\s+\w+\s*:)/m.test(sample)) return 'typescript';
  if (/^\s*(?:(?:export\s+|async\s+)*(?:const|let|var|function|import)\s|console\.\w+\s*\()/m.test(sample)) return 'javascript';
  if (/^\s*(?:\$[\w:]+\s*=|(?:Get|Set|Write|Read|New|Remove|Import|Invoke)-[a-z]+\b)/im.test(sample)) return 'powershell';
  if (/^(?:SELECT\s|WITH\s+\w+\s+AS\s*\(|CREATE\s+TABLE\s|INSERT\s+INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s)/i.test(sample)) return 'sql';
  if (/^[.#]?[\w-]+(?:\s*[,>+~]\s*[.#]?[\w-]+)*\s*\{\s*[\w-]+\s*:/.test(sample)) return 'css';
  if (/^(?:---\s*\r?\n|[\w.-]+:\s[^\n]*\n\s*(?:[\w.-]+:|-[ \t]))/.test(sample)) return 'yaml';
  return 'plain';
}

const keywordLists = {
  javascript: 'as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield',
  typescript: 'abstract any as asserts boolean declare enum implements infer interface is keyof module namespace never number override private protected public readonly satisfies string symbol type unknown',
  python: 'and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield',
  powershell: 'begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using while workflow',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  rust: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type unsafe use where while',
  shell: 'case do done elif else esac eval export fi for function if in local readonly return select then time until while',
  sql: 'all alter and as asc begin between by case commit count create delete desc distinct drop else end exists from group having in inner insert into is join left like limit not offset on or order outer right select set table then union update values when where with'
};
keywordLists.typescript += ' ' + keywordLists.javascript;
const keywords = new Map(Object.entries(keywordLists).map(([id, words]) => [id, new Set(words.split(' '))]));

const string = /"(?:\\[\s\S]|[^"\\\r\n])*(?:"|\\?)|'(?:\\[\s\S]|[^'\\\r\n])*(?:'|\\?)/;
const quotedJSON = /"(?:\\[\s\S]|[^"\\\r\n])*(?:"|\\?)/;
const backtick = /`(?:\\[\s\S]|[^`\\])*(?:`|\\?)/;
const triple = /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/;
const blockComment = /\/\*[\s\S]*?(?:\*\/|$)/;
const slashComment = /\/\/[^\r\n]*/;
const hashComment = /#[^\r\n]*/;
const number = /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)\b/;
const jsonNumber = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const jsonKey = /"(?:\\[\s\S]|[^"\\\r\n])*"(?=\s*:)/;
const word = /[A-Za-z_$][\w$]*/;
const punctuation = /[{}()\[\]:,.;=+*!<>%&|?\/-]+/;
const cLanguages = new Set(['javascript', 'typescript', 'go', 'rust']);
const hashLanguages = new Set(['python', 'powershell', 'shell', 'yaml']);

// Capture one lexical category per group. Unmatched text is emitted verbatim.
function makeGrammar(id) {
  const rules = [];
  function add(kind, pattern) { rules.push([kind, pattern]); }
  if (id === 'json') {
    add('key', jsonKey); add('string', quotedJSON); add('number', jsonNumber);
    add('literal', /\b(?:true|false|null)\b/); add('operator', /[{}\[\]:,]+/);
  } else {
    if (id === 'html') {
      add('comment', /<!--[\s\S]*?(?:-->|$)/);
      add('tag', /<\/?[\w:-]+|<![\w:-]+|<\?[\w:-]+|\/?>/);
      add('key', /[\w:-]+(?=\s*=)/);
    }
    if (cLanguages.has(id) || id === 'css' || id === 'sql') add('comment', blockComment);
    if (cLanguages.has(id)) add('comment', slashComment);
    if (id === 'powershell') add('comment', /<#[\s\S]*?(?:#>|$)/);
    if (hashLanguages.has(id)) add('comment', hashComment);
    if (id === 'sql') add('comment', /--[^\r\n]*/);
    if (id === 'yaml' || id === 'css') add('key', /[\w-]+(?=\s*:)/);
    if (id === 'python') add('string', triple);
    if (['javascript', 'typescript', 'go', 'shell'].includes(id)) add('string', backtick);
    add('string', string);
    if (id === 'powershell') add('keyword', /\b[A-Za-z]+-[A-Za-z]+\b/);
    add('number', number); add('word', word); add('operator', punctuation);
  }
  return { regex: new RegExp(rules.map(([, rule]) => '(' + rule.source + ')').join('|'), 'g'),
    kinds: rules.map(([kind]) => kind) };
}

const grammars = new Map();
export function highlightCode(text, language = 'auto') {
  let id = codeLanguage(language);
  if (id === 'auto') id = detectCodeLanguage(text);
  if (id === 'plain' || !text) return text ? [{ kind: 'plain', text }] : [];
  if (!grammars.has(id)) grammars.set(id, makeGrammar(id));
  const { regex, kinds } = grammars.get(id);
  const tokens = [];
  const add = (kind, value) => {
    if (!value) return;
    if (tokens.at(-1)?.kind === kind) tokens.at(-1).text += value;
    else tokens.push({ kind, text: value });
  };
  let end = 0;
  for (const match of text.matchAll(regex)) {
    add('plain', text.slice(end, match.index));
    let kind = kinds[match.findIndex((value, i) => i > 0 && value !== undefined) - 1];
    if (kind === 'word') {
      const token = ['powershell', 'sql'].includes(id) ? match[0].toLowerCase() : match[0];
      if (/^(?:true|false|null|nil|undefined|True|False|None|\$true|\$false|\$null)$/.test(token)) kind = 'literal';
      else kind = keywords.get(id)?.has(token) ? 'keyword' : 'plain';
    }
    add(kind, match[0]);
    end = match.index + match[0].length;
    // Keep editing responsive for large dumps. Copy and search retain the complete source.
    if (tokens.length >= 12000) break;
  }
  add('plain', text.slice(end));
  return tokens;
}

const jsonWhitespace = /[\x20\t\r\n]*/y;
const jsonAtom = new RegExp('(?:true|false|null|' + jsonNumber.source + ')', 'y');
const hexDigit = /[\da-f]/i;

// Report the first misplaced character, including the end of an unfinished string.
function jsonString(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return { end: i + 1 };
    if (c.charCodeAt(0) < 32) return { error: i };
    if (c !== '\\') continue;
    const escaped = text[++i];
    if (escaped === 'u') {
      for (let digit = 0; digit < 4; digit++) {
        i++;
        if (i === text.length || !hexDigit.test(text[i])) return { error: i };
      }
    } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) return { error: i };
  }
  return { error: text.length };
}

function jsonError(text, offset) {
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
  return { ok: false, text, line: lines.length, column: Array.from(lines.at(-1)).length + 1 };
}

// Format source lexemes directly so large integers, duplicate keys, escape choices
// and the author's key order survive. A stack also handles deeply nested documents.
export function formatJSON(text) {
  const output = [], closers = [];
  let state = 'value', previous = '', i = 0;
  while (true) {
    jsonWhitespace.lastIndex = i;
    jsonWhitespace.exec(text);
    i = jsonWhitespace.lastIndex;
    if (i === text.length) break;
    const start = i, c = text[i];
    const closing = c === '}' || c === ']';
    if (closing) {
      if (closers.at(-1) !== c || !['separator', 'firstKey', 'firstValue'].includes(state))
        return jsonError(text, i);
      closers.pop();
      state = closers.length ? 'separator' : 'done';
      i++;
    } else if (state === 'separator' && c === ',') {
      state = closers.at(-1) === '}' ? 'key' : 'value';
      i++;
    } else if (state === 'colon' && c === ':') {
      state = 'value';
      i++;
    } else if ((state === 'key' || state === 'firstKey') && c === '"') {
      const scanned = jsonString(text, i);
      if (scanned.error !== undefined) return jsonError(text, scanned.error);
      i = scanned.end;
      state = 'colon';
    } else if (state === 'value' || state === 'firstValue') {
      if (c === '{' || c === '[') {
        state = c === '{' ? 'firstKey' : 'firstValue';
        i++;
      } else {
        if (c === '"') {
          const scanned = jsonString(text, i);
          if (scanned.error !== undefined) return jsonError(text, scanned.error);
          i = scanned.end;
        } else {
          jsonAtom.lastIndex = i;
          if (!jsonAtom.exec(text)) return jsonError(text, i);
          i = jsonAtom.lastIndex;
        }
        state = closers.length ? 'separator' : 'done';
      }
    } else return jsonError(text, i);

    const afterOpen = previous === '{' || previous === '[';
    if ((afterOpen && !closing) || previous === ',' || (closing && !afterOpen)) {
      // Bound indentation growth on machine-generated, deeply nested input.
      output.push('\n', '  '.repeat(Math.min(closers.length, 40)));
    } else if (previous === ':') output.push(' ');
    output.push(text.slice(start, i));
    if (c === '{' || c === '[') closers.push(c === '{' ? '}' : ']');
    previous = c;
  }
  return state === 'done' ? { ok: true, text: output.join('') } : jsonError(text, i);
}
