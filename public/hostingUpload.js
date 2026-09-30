import {unzipSync} from 'fflate';
export async function prepareHostingFiles(input){
 let result=[];
 for(const file of input){
  if(file.name.toLowerCase().endsWith('.zip')){
   if(file.size>50*1024*1024)throw new Error('ZIP exceeds website upload limits.');
   let expanded=0,count=0;
   const entries=unzipSync(new Uint8Array(await file.arrayBuffer()),{filter(entry){
    if(entry.name.endsWith('/')||entry.name.startsWith('__MACOSX/'))return false;
    expanded+=entry.originalSize;count++;
    if(entry.originalSize>20*1024*1024||expanded>50*1024*1024||count>500)throw new Error('ZIP exceeds website upload limits.');return true;
   }});
   result.push(...Object.entries(entries).map(([path,data])=>({path,file:new Blob([data])})));
  }else result.push({path:file.webkitRelativePath||file.name,file});
 }
 // Validate before stripping a wrapper so ../index.html cannot become index.html.
 if(result.some(f=>f.path.startsWith('/')||f.path.includes('\\')||f.path.split('/').some(p=>!p||p==='.'||p==='..')))throw new Error('Invalid website file path.');
 // Remove only a shared folder wrapper; preserve paths inside the website.
 if(result.length&&result.every(f=>f.path.includes('/')&&f.path.split('/')[0]===result[0].path.split('/')[0])&&!result.some(f=>f.path==='index.html'))result=result.map(f=>({...f,path:f.path.slice(f.path.indexOf('/')+1)}));
 const seen=new Set();let size=0;
 for(const f of result){if(!f.path||f.path.startsWith('/')||f.path.includes('\\')||f.path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(f.path.toLowerCase()))throw new Error('Invalid or duplicate website file path.');seen.add(f.path.toLowerCase());size+=f.file.size;if(f.file.size>20*1024*1024)throw new Error('A file exceeds 20 MB.');}
 if(!seen.has('index.html')||result.length>500||size>50*1024*1024)throw new Error('Root index.html required, with at most 500 files and 50 MB total.');
 return result;
}
