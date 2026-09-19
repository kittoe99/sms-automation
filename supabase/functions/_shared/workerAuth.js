export const env=name=>globalThis.Deno?.env.get(name) ?? globalThis.process?.env[name];
export const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export function constantTimeToken(a,b) {
 if(typeof a!=='string' || typeof b!=='string' || a.length!==b.length) return false;
 let difference=0;for(let i=0;i<a.length;i++) difference|=a.charCodeAt(i)^b.charCodeAt(i);
 return difference===0;
}
