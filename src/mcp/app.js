import express from 'express';
import {randomUUID} from 'node:crypto';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createMcpServer} from './tools.js';

export function createMcpApp({config,metadata,verify,invoke,log=event=>console.log(JSON.stringify(event))}) {
 const app=express(),origin=new URL(config.resource).origin;
 app.disable('x-powered-by');
 app.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(req.get('host')!==new URL(origin).host)return res.status(403).json({error:'Host denied'});
  const requestOrigin=req.get('origin');
  if(requestOrigin&&!config.origins.includes(requestOrigin))return res.status(403).json({error:'Origin denied'});
  if(requestOrigin){res.set('Access-Control-Allow-Origin',requestOrigin);res.vary('Origin');}
  res.set('Access-Control-Expose-Headers','WWW-Authenticate, MCP-Protocol-Version');
  if(req.method==='OPTIONS')return res.set({'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,Accept,MCP-Protocol-Version,MCP-Session-Id'}).sendStatus(204);
  next();
 });
 app.get('/health',(_req,res)=>res.json({status:'ok',service:'e2-crm-mcp'}));
 app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'],(_req,res)=>res.json({resource:config.resource,authorization_servers:[config.issuer],scopes_supported:['profile','offline_access'],bearer_methods_supported:['header']}));
 app.get('/.well-known/oauth-authorization-server',(_req,res)=>res.json(metadata));
 app.use('/mcp',async(req,res,next)=>{
  const raw=req.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  try {if(!raw)throw new Error('Missing token');req.identity=await verify(raw);next();}
  catch(error){const status=error.status>=500?503:401;res.set('WWW-Authenticate',`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`);res.status(status).json({error:status===503?'temporarily_unavailable':'invalid_token'});}
 });
 app.use('/mcp',express.json({limit:'64kb'}));
 app.post('/mcp',async(req,res)=>{
  const requestId=randomUUID();
  const server=createMcpServer({identity:req.identity,requestId,invoke:async(...args)=>{
   try{return await invoke(...args);}catch{log({event:'mcp_database_unavailable',requestId});return {ok:false,error:{code:'TEMPORARY_FAILURE',message:'Service temporarily unavailable. Retry mutations with the same idempotency key.',retryable:true}};}
  }});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close',()=>{void transport.close();void server.close();});
  try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}
  catch{log({event:'mcp_transport_error',requestId});if(!res.headersSent)res.status(500).json({error:'Service temporarily unavailable',requestId});}
 });
 app.all('/mcp',(_req,res)=>res.status(405).set('Allow','POST, OPTIONS').json({error:'Method not allowed'}));
 app.use((error,_req,res,_next)=>res.status(error.status===413?413:400).json({error:error.status===413?'Payload too large':'Invalid request'}));
 return app;
}
