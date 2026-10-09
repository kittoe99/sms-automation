import postgres from 'postgres';
export function runtimeDatabase(url,{maintenance=false,connect=postgres}={}) {
 let sql;
 return {async call(name,...args){
  if(name!==(maintenance?'cleanup':'dispatch'))throw new Error('Unsupported runtime operation');
  if(!url)throw new Error('Runtime database unavailable');
  sql??=connect(url,{ssl:'require',prepare:false,max:2,connect_timeout:5,idle_timeout:10,connection:{statement_timeout:8000}});
  // Postgres.js serializes json/jsonb parameters after resolving their SQL types.
  // Pre-stringifying here turns a JSON object into a JSON string in PostgreSQL.
  const rows=await sql.unsafe(`select ${maintenance?'voice_maintenance_api':'voice_runtime_api'}.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args);
  return rows[0]?.result;
 }};
}
