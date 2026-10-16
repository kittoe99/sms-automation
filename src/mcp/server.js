import {withHostingAdapter} from './hostingAdapter.js';
import {withVoiceMedia} from './voiceMedia.js';
import 'dotenv/config';
import {mcpConfig,createOAuthVerifier,getOAuthMetadata} from './auth.js';
import {createMcpDatabase} from './database.js';
import {createMcpApp} from './app.js';
import {withKnowledgeUpload} from './knowledgeUpload.js';
import {withEmailAdapter} from './emailAdapter.js';

const config=mcpConfig(),metadata=await getOAuthMetadata(config),db=createMcpDatabase(config);
const adapterOptions={adapterUrl:process.env.MCP_KNOWLEDGE_ADAPTER_URL};
const invoke=withHostingAdapter(withVoiceMedia(withKnowledgeUpload(withEmailAdapter(db.invoke,db.emailActionTicket,adapterOptions),db.knowledgeUploadTicket,adapterOptions),db.voiceMediaTicket,adapterOptions),db.hostingTicket,{adapterUrl:process.env.MCP_HOSTING_ADAPTER_URL});
const app=createMcpApp({config,metadata,verify:createOAuthVerifier(config),invoke});
const server=app.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log(JSON.stringify({event:'mcp_listening'})));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;server.close(async()=>{await db.close();process.exit(0);});setTimeout(()=>process.exit(1),25000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
