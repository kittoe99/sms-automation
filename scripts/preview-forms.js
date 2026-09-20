// Local-only synthetic data harness; never connects to a production database.
import express from 'express';
import {fileURLToPath} from 'node:url';
import {testDatabase,call} from '../test/helpers/database.js';
import {createFormsApp} from '../src/formsServer.js';
const port=Number(process.env.FORM_PREVIEW_PORT||8088);
process.env.NODE_ENV='test';process.env.FORMS_SIGNING_SECRET='local-preview-signing-secret-123456789';
process.env.CRM_ALLOWED_ORIGINS=`http://127.0.0.1:${port}`;process.env.FORMS_PUBLIC_BASE_URL=process.env.CRM_ALLOWED_ORIGINS;
delete process.env.FORMS_TURNSTILE_SECRET;delete process.env.FORMS_TURNSTILE_SITE_KEY;
const sql=await testDatabase(),db={call:(name,...args)=>call(sql,name,...args)};
await call(sql,'api_action','admin',null,'create_business',{id:'preview',name:'Helpful Company',timeZone:'America/Denver'});
await sql.exec("insert into sms_private.form_features values('preview',true)");
for(const id of ['quote-requests','commercial-followup'])await call(sql,'api_action','admin','preview','group',{id,name:id==='quote-requests'?'Quote Requests':'Commercial Follow-up',rule:{steps:[{template:'Hi {{first_name}}, Helpful Company here about your {{service_name}} request. Reply STOP to opt out.',delayCount:1,delayUnit:'day'}]}});
const {app:forms}=createFormsApp(db,{verify:async()=> 'admin'}),app=express();
app.get('/',(_req,res)=>res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Form Builder test workspace</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/form-builder.css"></head><body><main style="padding:32px"><h1>Form Builder</h1><p>Local test workspace · synthetic data</p><div id="root"></div></main><script type="module" src="/preview.js"></script></body></html>`));
app.get('/preview.js',(_req,res)=>res.type('js').send(`import {mountFormBuilder} from '/form-builder.js';await mountFormBuilder(document.getElementById('root'),{runtimeConfig:{},apiFetch:(url,options={})=>fetch(url,{...options,headers:{...options.headers,'X-Tenant-ID':'preview'}})});`));
app.use(express.static(fileURLToPath(new URL('../public/',import.meta.url)),{index:false}));app.use(forms);
const server=app.listen(port,'127.0.0.1',()=>console.log('Local form test workspace: '+process.env.FORMS_PUBLIC_BASE_URL));
process.once('SIGINT',()=>{server.close();sql.close();});
