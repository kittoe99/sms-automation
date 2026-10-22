import postgres from 'postgres';
export function smsDatabase(url,{connect=postgres}={}){
 let sql;
 return {async call(action,...args){
  if(!['readiness','send'].includes(action))throw new Error('Unsupported SMS operation');
  if(!url)throw new Error('SMS database unavailable');
  sql??=connect(url,{ssl:'require',prepare:false,max:2,connect_timeout:5,idle_timeout:10,connection:{statement_timeout:8000}});
  const rows=await sql.unsafe(`select voice_sms_api.${action}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args);
  return rows[0]?.result;
 }};
}
