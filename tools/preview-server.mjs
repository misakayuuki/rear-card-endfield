import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'build/module');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'};
http.createServer(async (req,res) => {
  try {
    let name=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    if(name==='/card-preview.html'||name==='/preview-bridge.js') {
      const data=await readFile(path.join(root,'tools',name.slice(1)));
      res.writeHead(200,{'Content-Type':types[path.extname(name)],'Cache-Control':'no-store'});res.end(data);return;
    }
    if(name==='/') {res.writeHead(302,{Location:'/webroot/index.html'});res.end();return;}
    if(name==='/webroot/bridge-shim.js') {res.writeHead(200,{'Content-Type':types['.js']});res.end('// Browser preview: no native bridge.');return;}
    const file=path.resolve(base,'.'+name);
    if(!file.startsWith(base+path.sep)) {res.writeHead(403);res.end();return;}
    const data=await readFile(file);
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
  } catch {res.writeHead(404);res.end('Not found');}
}).listen(4173,'127.0.0.1',()=>console.log('Preview: http://127.0.0.1:4173'));
