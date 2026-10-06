import postgres from 'postgres';
const allowed=new Set(['availability','prepare','confirm']);
export function bookingDatabase(url){
 let sql;
 return {async call(name,...args){
  if(!allowed.has(name))throw new Error('Unsupported booking operation');
  if(!url)throw new Error('Booking database unavailable');
  sql??=postgres(url,{ssl:'require',prepare:false,max:2,connect_timeout:5,idle_timeout:10,connection:{statement_timeout:8000}});
  const rows=await sql.unsafe(`select voice_booking_api.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args.map(v=>v&&typeof v==='object'?JSON.stringify(v):v));
  return rows[0]?.result;
 }};
}
