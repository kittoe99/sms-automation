import {readFile,readdir,stat} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../',import.meta.url));
const main=['docs/CRM_MCP.md','docs/MCP_ROLLOUT.md','docs/AI_REPLY_DIAGNOSTICS.md','docs/MCP_IMPLEMENTATION_HISTORY.md','docs/MCP_ROLLOUT_HISTORY.md','docs/AI_REPLY_HISTORY.md'];
const files=[...main,...(await readdir(resolve(root,'docs/mcp'))).filter(x=>x.endsWith('.md')).map(x=>'docs/mcp/'+x)];
const decode=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
const anchors=new Map();let links=0;
async function getAnchors(path){
 if(anchors.has(path))return anchors.get(path);
 const text=decode(await readFile(path)),set=new Set(),seen=new Map();let fence=false;
 for(const line of text.split(/\r?\n/)){
  if(/^\s*```/.test(line)){fence=!fence;continue;}if(fence)continue;
  const heading=line.match(/^#{1,6}\s+(.+?)\s*#*$/);if(!heading)continue;
  const base=heading[1].toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu,'').replace(/\s/g,'-');
  const count=seen.get(base)||0;seen.set(base,count+1);set.add(base+(count?'-'+count:''));
 }
 anchors.set(path,set);return set;
}
async function verify(source,href){
 if(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href))return;
 const [raw,fragment]=href.split('#'),target=raw?resolve(dirname(source),decodeURIComponent(raw)):source;
 assert.ok((await stat(target)).isFile(),`${source}: missing ${href}`);
 if(fragment&&extname(target)==='.md')assert.ok((await getAnchors(target)).has(decodeURIComponent(fragment)),`${source}: missing anchor ${href}`);
 links++;
}
for(const file of files){
 const path=resolve(root,file),text=decode(await readFile(path));
 for(const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g))await verify(path,match[1]);
}
// Incoming checkpoint links must continue to resolve after archiving. Other
// unrelated guides can retain paired checkout links outside this package.
for(const file of (await readdir(resolve(root,'docs'))).filter(x=>x.endsWith('.md'))){
 const path=resolve(root,'docs',file),text=decode(await readFile(path));
 for(const match of text.matchAll(/\[[^\]\n]*\]\(((?:CRM_MCP|MCP_IMPLEMENTATION_HISTORY|AI_REPLY_DIAGNOSTICS|AI_REPLY_HISTORY|MCP_ROLLOUT|MCP_ROLLOUT_HISTORY)\.md(?:#[^)\s]+)?)\)/g))await verify(path,match[1]);
}
console.log(`Verified UTF-8 and ${links} local links/anchors in ${files.length} MCP guides plus incoming MCP links; no network requests.`);
