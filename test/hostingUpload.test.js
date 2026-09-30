import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {prepareHostingFiles} from '../public/hostingUpload.js';
const file=(name,text='site',path='')=>Object.assign(new File([text],name),{webkitRelativePath:path});
test('folder and ZIP uploads remove a single wrapper and preserve website paths',async()=>{
 const folder=await prepareHostingFiles([file('index.html','site','site/index.html'),file('app.js','site','site/js/app.js')]);
 assert.deepEqual(folder.map(f=>f.path),['index.html','js/app.js']);
 const zipped=zipSync({'site/index.html':strToU8('site'),'site/styles/main.css':strToU8('body{}')});
 const zip=await prepareHostingFiles([new File([zipped],'site.zip')]);assert.deepEqual(zip.map(f=>f.path),['index.html','styles/main.css']);
});
test('upload paths, duplicates, missing root and expansion limits fail before upload',async()=>{
 for(const files of [[file('index.html','site','../index.html')],[file('index.html'),file('INDEX.html')],[file('app.js')]])await assert.rejects(()=>prepareHostingFiles(files),/Invalid|index.html/);
 const zip=zipSync({'index.html':new Uint8Array(21*1024*1024)});await assert.rejects(()=>prepareHostingFiles([new File([zip],'site.zip')]),/exceeds/);
});
