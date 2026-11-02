// Disposable local browser fixture. All writes remain in PGlite; no provider is invoked.
import express from 'express';
import {resolve} from 'node:path';
import {testDatabase,call} from '../helpers/database.js';
import {emailAutomationAction} from '../../supabase/functions/crm-api/email-automations.js';
const db=await testDatabase();
await call(db,'api_action','admin',null,'create_business',{id:'email-preview',name:'Example Services',timeZone:'America/Denver'});
await db.exec("update public.sms_businesses set status='active'; update sms_private.email_sender_domains set status='verified'");
const secret=(await db.query("select vault.create_secret(repeat('a',32)) id")).rows[0].id;
await db.query('insert into vault.secrets(id) values($1)',[secret]);
await db.query("update sms_private.edge_config set enabled=true,secret_id=$1 where queue='automation_jobs'",[secret]);
await db.exec("insert into public.sms_contacts(tenant_id,phone,name,email) values('email-preview','+13035550100','Alex Example','alex@example.test')");
await call(db,'form_workspace','admin','email-preview','create',null,{title:'Request an estimate',preset:'contacts',description:'',buttonLabel:'Send',fields:[],enabled:false});
const adapter={call:(name,...args)=>call(db,name,...args)};
const app=express();app.use(express.json({limit:'64kb'}));app.use(express.static(resolve('public'),{index:false}));
app.post('/fixture/:action',async(req,res)=>{try{
 if(req.params.action==='sender')return res.status(400).json({error:'Provider operations are disabled in this local fixture.'});
 res.json(await emailAutomationAction(adapter,'admin','email-preview',req.params.action,req.body));
}catch(error){res.status(400).json({error:error.message});}});
app.get('/',(req,res)=>res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email workspace preview</title><style>body{margin:0;background:#f5f8fa;color:#173e4c;font:15px Arial,sans-serif}main{max-width:1100px;padding:24px;margin:auto;background:#fff}</style></head><body><main id="root"></main><script type="module">import {mountEmailWorkspace} from '/emailAutomationWorkspace.js';mountEmailWorkspace(document.querySelector('#root'),{staff:true,request:async(action,input)=>{const response=await fetch('/fixture/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;}});</script></body></html>`));
app.listen(8194,'127.0.0.1',()=>console.log('Disposable email preview: http://127.0.0.1:8194'));
