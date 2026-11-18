// Disposable local browser fixture for Email campaigns. All writes remain in PGlite;
// no provider is invoked and the dispatcher/worker never run.
import express from 'express';
import {resolve} from 'node:path';
import {testDatabase,call} from '../helpers/database.js';
const db=await testDatabase();
const tenant='campaign-preview';
await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Example Services',timeZone:'America/Denver'});
await db.exec("update public.sms_businesses set status='active'; update sms_private.email_sender_domains set status='verified'");
const secret=(await db.query("select vault.create_secret(repeat('a',32)) id")).rows[0].id;
await db.query('insert into vault.secrets(id) values($1)',[secret]);
await db.query("update sms_private.edge_config set enabled=true,secret_id=$1 where queue='automation_jobs'",[secret]);
const automation=(action,input)=>call(db,'email_automations','admin',tenant,action,{...input,idempotencyKey:crypto.randomUUID()});
await automation('settings',{revision:0,enabled:true,replyTo:'owner@example.test',mailingAddress:'123 Main Street, Denver, CO 80201'});
const people=[['Alex Example','alex@example.test','form',true],['Blake Sample','blake@example.test','form',false],['Casey Test','casey@example.test','contact',true],['Dana Demo','dana@sample.test','form',true]];
for(const [index,[name,email,source,consent]] of people.entries()) {
 const contact=(await db.query('insert into public.sms_contacts(tenant_id,phone,name,email,source) values($1,$2,$3,$4,$5) returning *',[tenant,`+1303555010${index}`,name,email,source])).rows[0];
 if(consent) await automation('consent',{contactId:contact.id,contactRevision:contact.revision,consent:true,evidence:'Fixture newsletter opt-in'});
}
const definition={purpose:'marketing',startHour:9,endHour:18,steps:[{subject:'Fall offers for {{firstName}}',anchor:'event',offsetMinutes:0,document:[{type:'paragraph',content:[{text:'Hello from {{businessName}}.'}]}]}]};
const template=await automation('create',{name:'Fall newsletter',definition});
await automation('publish',{id:template.id,revision:template.revision});
const app=express();app.use(express.json({limit:'64kb'}));app.use(express.static(resolve('public'),{index:false}));
app.post('/fixture/:action',async(req,res)=>{try{res.json(await call(db,'email_campaigns','admin',tenant,req.params.action,req.body||{}));}catch(error){res.status(400).json({error:error.message});}});
app.get('/',(req,res)=>res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email campaigns preview</title><style>body{margin:0;background:#f5f8fa;color:#173e4c;font:15px Arial,sans-serif}main{max-width:1100px;padding:24px;margin:auto;background:#fff}</style></head><body><main id="root"></main><script type="module">import {mountEmailCampaignWorkspace} from '/emailCampaignWorkspace.js';mountEmailCampaignWorkspace(document.querySelector('#root'),{request:async(action,input)=>{const response=await fetch('/fixture/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;}});</script></body></html>`));
app.listen(8195,'127.0.0.1',()=>console.log('Disposable campaign preview: http://127.0.0.1:8195'));
