import 'dotenv/config';
import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {frontendConfig} from './frontend-config.js';
import {build} from 'esbuild';
const config=await frontendConfig();
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(project,'dist');
if(resolve(process.cwd())!==project||dirname(output)!==project)throw new Error('Build must run in this repository; refusing to clean another directory');
await rm(output,{recursive:true,force:true});
await cp('public','dist',{recursive:true});await mkdir('dist/vendor',{recursive:true});
// Only hashed assets receive immutable caching. Keep public embed URLs and
// config.js stable, and preserve one shared auth module across lazy chunks.
const frontend=await build({entryPoints:['public/app.js','public/styles.css','public/e2-theme.css','public/dashboard-theme.css'],
  bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2022',minify:true,
  outdir:'dist/assets',entryNames:'[name]-[hash]',chunkNames:'chunk-[hash]',assetNames:'[name]-[hash]',
  external:['/vendor/*','/fonts/*'],loader:{'.woff2':'file','.svg':'file'},metafile:true});
let html=(await readFile('public/index.html','utf8')).replaceAll('\r\n','\n');
const preloads=new Set();
function preloadImports(output) {
  for(const dependency of frontend.metafile.outputs[output].imports) {
    if(dependency.external || dependency.kind==='dynamic-import' || preloads.has(dependency.path))continue;
    preloads.add(dependency.path);preloadImports(dependency.path);
  }
}
for(const [output,meta] of Object.entries(frontend.metafile.outputs)) {
  if(!meta.entryPoint)continue;
  const name=meta.entryPoint.split('/').pop();
  if(!['app.js','styles.css','e2-theme.css','dashboard-theme.css'].includes(name))continue;
  const pattern=new RegExp(`(["'])/${name.replaceAll('.', '\\.')}\\?[^"']*(["'])`,'g');
  html=html.replace(pattern,`$1/${output.replace(/^dist\//,'')}$2`);
  if(name==='app.js')preloadImports(output);
}
html=html.replace('</head>',[...preloads].map(file=>`<link rel="modulepreload" href="/${file.replace(/^dist\//,'')}" />`).join('\n')+'\n  </head>');
await writeFile('dist/index.html',html);
await writeFile('dist/build-meta.json',JSON.stringify(frontend.metafile));
await build({stdin:{contents:"export {createClient} from '@supabase/supabase-js'",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',outfile:'dist/vendor/supabase.js',minify:true});
await build({entryPoints:['src/frontend/complianceEmbed.jsx'],bundle:true,format:'esm',platform:'browser',outfile:'dist/vendor/compliance-embed.js',minify:true});
await build({stdin:{contents:"export {unzipSync} from 'fflate'",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',outfile:'dist/vendor/fflate.js',minify:true});
await writeFile('dist/config.js',`globalThis.SMS_CONFIG=${JSON.stringify(config)};\n`);
