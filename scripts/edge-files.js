import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';

// A deployment contains the complete local import graph, including lazy imports.
// Credentials and unrelated legacy server files are never directory-copied.
export async function collectEdgeFiles(root=process.cwd()) {
  const pending=[],files=new Map();
  async function walk(dir) {
    for(const item of await readdir(path.join(root,dir),{withFileTypes:true})) {
      const name=`${dir}/${item.name}`;
      if(item.isDirectory())await walk(name);
      else if(/\.(?:js|ts|json)$/.test(name))pending.push(name);
    }
  }
  await walk('supabase/functions');
  while(pending.length) {
    const name=pending.pop();if(files.has(name))continue;
    if(!/^(?:supabase\/functions|src)\//.test(name)&&name!=='public/phoneNormalization.js')throw new Error(`Edge dependency outside permitted source roots: ${name}`);
    const content=await readFile(path.join(root,name),'utf8');files.set(name,content);
    if(name.endsWith('.json'))continue;
    const specifiers=[...content.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g),
      ...content.matchAll(/new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g)];
    for(const [,specifier] of specifiers) {
      if(!specifier.startsWith('.'))continue;
      const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(name),specifier));
      if(!/\.(?:js|ts|json)$/.test(dependency))throw new Error(`Use an explicit source extension in ${name}: ${specifier}`);
      pending.push(dependency);
    }
  }
  return [...files].sort(([a],[b])=>a.localeCompare(b)).map(([name,content])=>({name,content}));
}
