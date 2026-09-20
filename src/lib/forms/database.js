import postgres from 'postgres';
const operations=new Set(['forms_admin','forms_public','forms_agent','forms_rate','forms_process']);
export function formsDatabase(url=process.env.FORMS_DATABASE_URL) {
  let sql;
  return {
    async call(name,...args) {
      if(!operations.has(name)) throw new Error('Unknown forms operation');
      if(!url) throw new Error('FORMS_DATABASE_URL is required');
      sql??=postgres(url,{ssl:process.env.NODE_ENV==='test'?false:'require',prepare:false,max:3,connect_timeout:5,idle_timeout:10,connection:{statement_timeout:10000}});
      return (await sql.unsafe(`select sms_private.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args.map(v=>v&&typeof v==='object'?JSON.stringify(v):v)))[0]?.result;
    },
    close:async()=>{await sql?.end({timeout:5});},
  };
}
export function startFormProcessor(db,{intervalMs=2000,onResult=result=>console.log(JSON.stringify({event:'form_processed',...result}))}={}) {
  let stopped=false,current=Promise.resolve();
  const tick=()=>{current=(async()=>{
    try {for(let i=0;i<10&&!stopped;i++){const result=await db.call('forms_process');if(!result)break;onResult(result);}}
    catch(error){console.error(JSON.stringify({event:'form_processor_failed',code:error.code||'DATABASE_ERROR'}));}
    finally{if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref?.();}}
  })();};
  let timer=setTimeout(tick,intervalMs);timer.unref?.();
  return async()=>{stopped=true;clearTimeout(timer);await current;};
}
