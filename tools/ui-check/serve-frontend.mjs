import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultFrontend = fileURLToPath(new URL('../../frontend/', import.meta.url));
const types = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.png':'image/png'};

export async function serveFrontend(frontend=defaultFrontend) {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname==='/__qa_seed') { res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><title>Test fixture</title>'); return; }
      const filename = path.resolve(frontend, '.' + (pathname === '/' ? '/index.html' : pathname));
      const relative = path.relative(frontend, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(404).end(); return; }
      const data = await readFile(filename);
      res.writeHead(200, {'Content-Type': types[path.extname(filename)] || 'application/octet-stream'}).end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:'+server.address().port, close:() => new Promise(resolve=>server.close(resolve))};
}
