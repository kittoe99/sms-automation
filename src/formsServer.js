import 'dotenv/config';
import express from 'express';
import {pathToFileURL} from 'node:url';
import {createFormsRouter,formError} from './routes/forms.js';
import {formsDatabase,startFormProcessor} from './lib/forms/database.js';

export function createFormsApp(db,options={}) {
  const app=express();
  app.disable('x-powered-by');
  // Set only to the number of trusted reverse proxies in the deployment.
  app.set('trust proxy',Number(process.env.FORMS_TRUST_PROXY_HOPS||0));
  app.use(express.json({limit:'64kb'}));
  app.use((_req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');next();});
  app.get('/health',(_req,res)=>res.json({ok:true,service:'forms'}));
  const router=createFormsRouter(db,options);app.use(router);app.use(formError);
  app.use((_req,res)=>res.status(404).json({error:'Not found'}));
  return {app,router};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(!process.env.FORMS_DATABASE_URL||!process.env.FORMS_SIGNING_SECRET||process.env.FORMS_SIGNING_SECRET.length<32) throw new Error('Configure FORMS_DATABASE_URL and FORMS_SIGNING_SECRET');
  if(process.env.NODE_ENV==='production') {
    if(!/^https:\/\//.test(process.env.FORMS_PUBLIC_BASE_URL||'')) throw new Error('HTTPS FORMS_PUBLIC_BASE_URL required');
  }
  const db=formsDatabase(),{app,router}=createFormsApp(db);
  const server=app.listen(Number(process.env.PORT||8081),()=>console.log('Form Builder service listening'));
  const stopProcessor=startFormProcessor(db);
  async function stop(){server.close();await stopProcessor();await router.waitForTasks();await db.close();}
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
