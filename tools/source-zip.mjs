import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from '../upstream/rear-card-bridge/tools/card-build/node_modules/fflate/esm/index.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await readFile(path.join(root,'src/module.json'),'utf8'));
const entries={};
async function add(name){
  const full=path.join(root,name);
  const children=await readdir(full,{withFileTypes:true});
  for(const child of children){
    const relative=name+'/'+child.name;
    if(child.isDirectory())await add(relative);
    else if(child.isFile())entries[relative]=new Uint8Array(await readFile(path.join(root,relative)));
  }
}
for(const dir of ['src','tools','tests','previews'])await add(dir);
for(const name of ['package.json','package-lock.json','README.md','.gitignore','research/api-notes.md']){
  entries[name]=new Uint8Array(await readFile(path.join(root,name)));
}
await mkdir(path.join(root,'dist'),{recursive:true});
await writeFile(path.join(root,'dist',`endfield-rear-card-source-${manifest.version}.zip`),zipSync(entries,{level:9}));
console.log('Source ZIP written (no credentials, dependencies or research checkouts).');
