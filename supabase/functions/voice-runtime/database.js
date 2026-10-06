import postgres from 'postgres';
export function runtimeDatabase(url,{maintenance=false}={}) {
 let sql;
 return {async call(name,...args){
  if(name!==(maintenance?'cleanup':'dispatch'))throw new Error('Unsupported runtime operation');
  if(!url)throw new Error('Runtime database unavailable');
  sql??=postgres(url,{ssl:'require',prepare:false,max:2,connect_timeout:5,idle_timeout:10,connection:{statement_timeout:8000}});
  const rows=await sql.unsafe(`select ${maintenance?'voice_maintenance_api':'voice_runtime_api'}.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args.map(x=>x&&typeof x==='object'?JSON.stringify(x):x));
  return rows[0]?.result;
 }};
}
