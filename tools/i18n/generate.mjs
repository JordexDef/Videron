import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {parse as parseJS} from 'acorn';
import {parse as parseHTML} from 'parse5';
import {parseLanguagePack} from '../../frontend/i18n.js';

const frontend = new URL('../../frontend/', import.meta.url);
const destination = new URL('languages/template.json', frontend);
const keys = new Set();

// These modules pass labels from tables to tr instead of writing them inline.
const labelColumns = {
  'appearance.js': {forms:1, colors:2},
  'icons/vectors.js': {vectors:2},
  'icons/lucide-extra.js': {lucideExtra:2},
  'icons/phosphor-extra.js': {phosphorExtra:2},
  'data-editor.js': {operations:2},
};
const indirectCalls = {
  'appearance.js': ['tr(...forms[i])', 'tr(ru,en)', 'tr(item.ru,item.en)'],
  'data-editor.js': ['tr(ru,en)'],
  'formula-completion.js': ['translateFor(language,...descriptions[fn])'],
  'i18n.js': ['tr(russian,english)', 'translateFor(language,russian,english,params)'],
};

function add(text) {
  if (typeof text !== 'string' || !text.trim()) throw Error('Expected a nonempty English language-pack key.');
  keys.add(text);
}

function* nodes(root) {
  yield root;
  for (const value of Object.values(root)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) yield* nodes(child);
    } else if (value?.type) yield* nodes(value);
  }
}

function collectJS(file, source) {
  const ast = parseJS(source, {ecmaVersion:'latest', sourceType:'module', locations:true});
  for (const node of nodes(ast)) {
    if (node.type === 'VariableDeclarator') {
      const name = node.id.name;
      const column = labelColumns[file]?.[name];
      if (typeof column === 'number') {
        for (const row of node.init.elements) add(row.elements[column].value);
      }
      if (file === 'formula-completion.js' && name === 'descriptions') {
        for (const pair of node.init.properties) add(pair.value.elements[1].value);
      }
      if (file === 'data-editor.js' && name === 'russianPhrases') {
        for (const entry of node.init.properties) add(entry.key.value ?? entry.key.name);
      }
    }
    if (node.type !== 'CallExpression') continue;
    const fn = node.callee.name;
    if (fn !== 'tr' && fn !== 'translateFor') continue;
    const key = node.arguments[fn === 'tr' ? 1 : 2];
    if (key?.type === 'Literal') add(key.value);
    else if (key?.type === 'TemplateLiteral' && !key.expressions.length) add(key.quasis[0].value.cooked);
    else {
      const call = source.slice(node.start,node.end);
      if (!indirectCalls[file]?.includes(call.replace(/\s+/g,''))) {
        throw Error(`${file}:${node.loc.start.line}: register the source of the English phrases for ${call}`);
      }
    }
  }
}

function collectHTML(node) {
  for (const attr of node.attrs ?? []) {
    if (['data-en','data-en-title','data-en-aria'].includes(attr.name)) add(attr.value);
  }
  for (const child of node.childNodes ?? []) collectHTML(child);
}

async function collectDirectory(prefix = '') {
  for (const entry of await readdir(new URL(prefix,frontend), {withFileTypes:true})) {
    const file = prefix + entry.name;
    if (entry.isDirectory()) {
      if (file !== 'vendor') await collectDirectory(file + '/');
    } else if (file.endsWith('.js') || file.endsWith('.html')) {
      const source = await readFile(new URL(file,frontend), 'utf8');
      if (file.endsWith('.js')) collectJS(file, source);
      else collectHTML(parseHTML(source));
    }
  }
}

await collectDirectory();
const template = {
  apiVersion:1,
  type:'language',
  id:'example.language-template',
  name:'Translation template',
  locale:'und',
  description:'Replace the name, ID, language tag and English values with your translation.',
  messages:Object.fromEntries([...keys].sort().map(key => [key,key])),
};
parseLanguagePack(template);
const json = JSON.stringify(template,null,2) + '\n';
if (process.argv.includes('--check')) {
  const current = (await readFile(destination,'utf8')).replaceAll('\r\n','\n');
  if (current !== json) throw Error('The language template is out of date. Run npm run generate in tools/i18n.');
} else {
  await mkdir(new URL('.',destination), {recursive:true});
  await writeFile(destination,json);
}
console.log(`${keys.size} English keys in frontend/languages/template.json`);
