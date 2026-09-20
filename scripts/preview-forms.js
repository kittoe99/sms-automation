import express from 'express';
import {fileURLToPath} from 'node:url';

const port=Number(process.env.FORM_PREVIEW_PORT||8088);
const publicDirectory=fileURLToPath(new URL('../public/',import.meta.url));
const indexFile=fileURLToPath(new URL('../public/index.html',import.meta.url));
const app=express();

app.use(express.static(publicDirectory,{index:false,etag:false,maxAge:0,setHeaders(res){
  res.setHeader('Cache-Control','no-store');
}}));
app.get('*',(_req,res)=>res.sendFile(indexFile));

const server=app.listen(port,'127.0.0.1',()=>{
  console.log(`Connected Form Builder test deployment: http://127.0.0.1:${port}`);
});
process.once('SIGINT',()=>server.close());
