// Run npm ci && npm run build here to refresh the browser bundle.
import {build} from 'esbuild';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, '../../frontend/vendor/codemirror');
await mkdir(dest, {recursive:true});
const result = await build({
  absWorkingDir:here, entryPoints:['editor-core.mjs'], outfile:join(dest, 'editor-core.js'),
  bundle:true, format:'esm', target:'es2022', minify:true, legalComments:'none', metafile:true
});
const packages = new Set();
for (const source of Object.keys(result.metafile.inputs)) {
  const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(source);
  if (match) packages.add(match[1]);
}
const licenses = [];
for (const name of [...packages].sort()) {
  const root = join(here,'node_modules',name);
  const info = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  licenses.push(name+' '+info.version+'\n\n'+(await readFile(join(root,'LICENSE'),'utf8')).trim());
}
await writeFile(join(dest,'LICENSES.txt'),licenses.join('\n\n'+'-'.repeat(72)+'\n\n')+'\n');
