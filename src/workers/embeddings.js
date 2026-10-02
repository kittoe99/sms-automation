import {DEFAULT_EMBEDDING_MODEL} from './ai.js';
const env=name=>globalThis.Deno?.env.get(name) ?? globalThis.process?.env[name];
const fail=(message,code,permanent=false)=>Object.assign(new Error(message),{code,permanent});
export async function processEmbeddings(job,db,{fetchImpl=fetch,apiKey=env('OPENAI_API_KEY'),model=env('EMBEDDING_MODEL') || DEFAULT_EMBEDDING_MODEL}={}) {
 try{
  if(!apiKey) throw fail('AI key is not configured','AI_NOT_CONFIGURED',true);
  const ctx=await db.call('knowledge_job_context',job.id,job.lease_token),chunks=(ctx.chunks || []).filter(x=>!x.embedding).slice(0,64);
  if(!chunks.length) return db.call('complete_embeddings',job.id,job.lease_token,{model,items:[]});
  const response=await fetchImpl('https://api.openai.com/v1/embeddings',{method:'POST',signal:AbortSignal.timeout(40000),headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,input:chunks.map(x=>x.content),dimensions:1536,encoding_format:'float'})});
  if(!response.ok) throw fail('Embedding request failed',`OPENAI_${response.status}`,response.status>=400&&response.status<500&&![408,429].includes(response.status));
  const data=await response.json();if(!Array.isArray(data.data)||data.data.length!==chunks.length||data.data.some(x=>!Array.isArray(x.embedding)||x.embedding.length!==1536))throw fail('Invalid embedding response','AI_INVALID_EMBEDDING');
  const items=chunks.map((chunk,index)=>({id:chunk.id,embedding:`[${data.data[index].embedding.join(',')}]`}));
  return db.call('complete_embeddings',job.id,job.lease_token,{model,items});
 }catch(error){if(error.permanent||job.attempts>=5)await db.call('fail_knowledge_job',job.id,job.lease_token,error.code||'EMBEDDING_FAILED').catch(()=>{});throw error;}
}
