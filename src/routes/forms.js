import {Router} from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,createHmac} from 'node:crypto';
import {authenticate,cors} from '../../supabase/functions/_shared/http.js';
import {FormService,bad} from '../lib/forms/service.js';
import {formMcpHandler} from '../lib/forms/mcp.js';
import {runBuilderTurn} from '../lib/forms/agent.js';
import {signFormToken,verifyFormToken} from '../lib/forms/tokens.js';
import {normalizeAnswers,mapAnswers,routeSubmission,publicDefinition} from '../../public/form-schema.js';
const publicDir=fileURLToPath(new URL('../../public/',import.meta.url));
const uuid=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s||'');
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
function incoming(req){return new Request('https://forms.internal'+req.originalUrl,{headers:new Headers(Object.entries(req.headers).filter(([,v])=>typeof v==='string'))});}
function baseUrl(req){return (process.env.FORMS_PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'');}
export function createFormsRouter(db,{verify=authenticate,runAgent=runBuilderTurn,fetchImpl=fetch}={}) {
  const router=Router();const tasks=new Set();
  router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  const rate=async(req,key,max,seconds)=>{
    const secret=process.env.FORMS_SIGNING_SECRET;if(!secret) throw bad('Forms service is not configured',503);
    const hash=createHmac('sha256',secret).update(String(req.ip)).digest('hex');
    if(!await db.call('forms_rate',`${key}:${hash}`,max,seconds)) throw bad('Too many requests. Please try again later.',429);
  };
  router.post('/mcp/forms',formMcpHandler(db));
  router.all('/mcp/forms',(_req,res)=>res.status(405).json({error:'Use POST'}));
  router.get('/forms-assets/:file',wrap(async(req,res)=>{
    if(!['form-renderer.js','form-schema.js','form-embed.js','form-public.js','form-public.css'].includes(req.params.file)) throw bad('Not found',404);
    res.setHeader('Cache-Control','public, max-age=300');res.sendFile(path.join(publicDir,req.params.file));
  }));
  const published=async pid=>{if(!uuid(pid)) throw bad('Form unavailable',404);return db.call('forms_public',pid,'get',{});};
  router.get('/forms/:publicId',wrap(async(req,res)=>{
    await rate(req,'render',120,60);
    const p=await published(req.params.publicId),origins=p.definition.allowedOrigins;
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'self' ${origins.join(' ')}`);
    res.sendFile(path.join(publicDir,'form-public.html'));
  }));
  router.get('/forms-public/:publicId',wrap(async(req,res)=>{
    await rate(req,'config',120,60);const p=await published(req.params.publicId);
    const token=await signFormToken({publicId:req.params.publicId,version:p.versionId},'forms-submit');
    res.json({definition:publicDefinition(p.definition),versionId:p.versionId,token,allowedOrigins:p.definition.allowedOrigins,turnstileSiteKey:process.env.FORMS_TURNSTILE_SITE_KEY||null,botProtection:process.env.FORMS_TURNSTILE_SITE_KEY?'turnstile':'proof_of_work',proofDifficulty:12});
  }));
  router.post('/forms-public/:publicId/submissions',wrap(async(req,res)=>{
    await rate(req,`submit:${req.params.publicId}`,10,60);
    if(!await db.call('forms_rate',`form-volume:${req.params.publicId}`,300,60)) throw bad('This form is busy. Please try again shortly.',429);
    if(req.get('Origin')!==new URL(baseUrl(req)).origin) throw bad('Origin denied',403);
    const p=await published(req.params.publicId),body=req.body||{};
    if(body.website) throw bad('Submission rejected');
    const token=await verifyFormToken(body.token,'forms-submit');
    if(token.publicId!==req.params.publicId||token.version!==body.versionId) throw bad('Form authorization mismatch',403);
    if(Date.now()/1000-token.iat<2) throw bad('Please review the form before submitting');
    if(!/^[a-zA-Z0-9_-]{8,100}$/.test(body.idempotencyKey||'')) throw bad('Valid submission key required');
    const parentOrigin=body.parentOrigin;
    if(parentOrigin && parentOrigin!==new URL(baseUrl(req)).origin&&!p.definition.allowedOrigins.includes(parentOrigin)) throw bad('Website origin is not allowed',403);
    if(process.env.FORMS_TURNSTILE_SECRET) {
      const response=await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:process.env.FORMS_TURNSTILE_SECRET,response:body.challengeToken,remoteip:req.ip})});
      const check=await response.json();
      if(!response.ok||!check.success||check.hostname!==new URL(baseUrl(req)).hostname) throw bad('Please complete the bot check');
    } else {
      const counter=Number(body.proofCounter);
      if(!Number.isSafeInteger(counter)||counter<0||counter>5000000) throw bad('Please complete the bot check');
      const digest=createHash('sha256').update(`${body.token}.${counter}`).digest();
      if(digest[0]!==0||(digest[1]&0xf0)!==0) throw bad('Please complete the bot check');
    }
    const answers=normalizeAnswers(p.definition,body.answers),mapped=mapAnswers(p.definition,answers);
    const disclosure=p.definition.fields.find(f=>f.id===p.definition.mappings.consent).disclosure;
    const result=await db.call('forms_public',req.params.publicId,'submit',{versionId:body.versionId,idempotencyKey:body.idempotencyKey,answers,mapped,groupId:routeSubmission(p.definition,answers),disclosure,origin:parentOrigin||req.get('Origin')});
    res.status(202).json(result);
  }));
  router.use('/api/forms',wrap(async(req,res,next)=>{
    const request=incoming(req),headers=cors(request);for(const[k,v]of Object.entries(headers)) res.setHeader(k,v);
    if(req.method==='OPTIONS') return res.sendStatus(204);
    const user=await verify(request),tenant=req.get('X-Tenant-ID');if(!tenant) throw bad('Select a business');
    req.forms=new FormService(db,user,tenant);await req.forms.call('catalog');
    await rate(req,`admin:${user}`,180,60);next();
  }));
  router.get('/api/forms',wrap(async(req,res)=>res.json(await req.forms.call('list'))));
  router.get('/api/forms/catalog',wrap(async(req,res)=>res.json(await req.forms.catalog())));
  router.post('/api/forms',wrap(async(req,res)=>res.status(201).json(await req.forms.create())));
  router.param('id',(req,res,next,id)=>uuid(id)?next():next(bad('Invalid form identifier')));
  router.get('/api/forms/:id',wrap(async(req,res)=>res.json(await req.forms.get(req.params.id))));
  router.put('/api/forms/:id',wrap(async(req,res)=>res.json(await req.forms.save(req.params.id,req.body.revision,req.body.definition,req.body.draftGroups))));
  router.post('/api/forms/:id/validate',wrap(async(req,res)=>res.json(await req.forms.validate(req.params.id))));
  router.post('/api/forms/:id/simulate',wrap(async(req,res)=>res.json(await req.forms.simulate(req.params.id,req.body.answers))));
  router.post('/api/forms/:id/publish',wrap(async(req,res)=>res.json(await req.forms.publish(req.params.id,req.body.revision))));
  router.post('/api/forms/:id/unpublish',wrap(async(req,res)=>res.json(await req.forms.call('unpublish',{id:req.params.id,revision:req.body.revision}))));
  router.get('/api/forms/:id/embed',wrap(async(req,res)=>{
    const f=await req.forms.get(req.params.id);if(!f.published_version) throw bad('Publish the form first');
    const base=baseUrl(req);res.json({url:`${base}/forms/${f.public_id}`,snippet:`<script src="${base}/forms-assets/form-embed.js" data-form="${f.public_id}" async></script>`});
  }));
  router.get('/api/forms/:id/submissions',wrap(async(req,res)=>res.json(await req.forms.call('submissions',{id:req.params.id}))));
  router.post('/api/forms/:id/submissions/:submissionId/retry',wrap(async(req,res)=>{
    if(!uuid(req.params.submissionId)) throw bad('Invalid submission');res.json(await req.forms.call('retry',{id:req.params.id,submissionId:req.params.submissionId}));
  }));
  router.post('/api/forms/:id/agent/messages',wrap(async(req,res)=>{
    const message=String(req.body.message||'').trim();if(!message||message.length>6000) throw bad('Enter a message up to 6000 characters');
    await req.forms.get(req.params.id);
    if(!await db.call('forms_rate',`agent-turns:${req.forms.tenant}`,20,3600)) throw bad('This business has reached its hourly form builder limit.',429);
    // Respond only after begin_turn succeeds, so concurrency/config errors reach the caller.
    let acknowledged=false;
    const task=runAgent(req.forms,req.params.id,message,{onStarted:()=>{acknowledged=true;res.status(202).json({started:true});}});
    tasks.add(task);
    task.catch(error=>{if(!acknowledged&&!res.headersSent) formError(error,req,res,()=>{});else console.error('form_agent_failed',error.code||'DATABASE_ERROR');}).finally(()=>tasks.delete(task));
    await Promise.race([task,new Promise(resolve=>res.once('finish',resolve))]);
    if(!res.headersSent) res.status(202).json({started:true});
  }));
  router.get('/api/forms/:id/agent/events',wrap(async(req,res)=>{
    const id=req.params.id;await req.forms.get(id);
    let cursor=Number(req.query.after)||0;
    res.setHeader('Content-Type','text/event-stream');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
    const until=Date.now()+25000;
    while(!res.destroyed&&Date.now()<until) {
      const {events}=await req.forms.call('audit',{id,after:cursor});
      for(const event of events){cursor=Number(event.id);res.write(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`);}
      res.write(': keepalive\n\n');
      await new Promise(resolve=>{const timer=setTimeout(done,1000);function done(){clearTimeout(timer);res.off('close',done);resolve();}res.once('close',done);});
    }
    res.end();
  }));
  router.get('/api/forms/:id/agent/session',wrap(async(req,res)=>res.json(await req.forms.call('session',{id:req.params.id}))));
  router.waitForTasks=()=>Promise.allSettled([...tasks]);
  return router;
}
export function formError(error,_req,res,next) {
  if(res.headersSent) {res.end();return;}
  const status=error.status||(error.code==='42501'?403:error.code==='23505'?409:error.code==='P0002'?404:['P0001','22P02','23514'].includes(error.code)?400:500);
  if(status>=500) console.error(JSON.stringify({event:'form_request_failed',code:error.code||'INTERNAL'}));
  res.status(status).json({error:status>=500?(error.status?error.message:'Form service temporarily unavailable'):error.message});
}
