import postgres from 'postgres';

// Fixed schema and RPC allowlist. This login has no sms_private schema access.
const allowed=new Set(['voice_read_business','voice_read_start_otp','voice_read_verify_otp','voice_read_customer']);
export function lookupDatabase(url){
  if(!url)throw new Error('Lookup database is not configured');
  const sql=postgres(url,{ssl:'require',prepare:false,max:2,connect_timeout:5,idle_timeout:10,
    connection:{statement_timeout:8000}});
  return {async call(name,...args){
    if(!allowed.has(name))throw new Error('Unsupported lookup operation');
    const result=await sql.unsafe(`select voice_lookup_api.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args);
    return result[0]?.result;
  }};
}
