import {readdir,readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
import {collectEdgeFiles} from './edge-files.js';
import {securityBlock} from './static-security.js';

let checked=0;
async function checkDirectory(directory) {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(entry.name==='vendor')continue;
    const file=`${directory}/${entry.name}`;
    if(entry.isDirectory())await checkDirectory(file);
    else if(/\.(js|jsx|ts)$/.test(file)) {
      await transform(await readFile(file,'utf8'),{loader:file.split('.').pop(),sourcefile:file,target:'es2022',logLevel:'silent'});
      checked++;
    }
  }
}
await Promise.all(['public','src','scripts','supabase/functions'].map(checkDirectory));
const blueprint=(await readFile('render.yaml','utf8')).replaceAll('\r\n','\n');
if(!blueprint.includes(await securityBlock()))throw new Error('Static headers drifted; run npm run headers:generate');
if(!/type: redirect\s+source: \/\*\s+destination: \//.test(blueprint))throw new Error('Unknown routes must redirect to the protected root');
const files=await collectEdgeFiles();
console.log(`Checked ${checked} source files, static security policy, and ${files.length} Edge dependencies.`);
