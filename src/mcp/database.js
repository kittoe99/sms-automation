import postgres from 'postgres';
export function createMcpDatabase(config) {
 const sql=postgres(config.databaseUrl,{ssl:'require',prepare:false,max:2,connect_timeout:5,idle_timeout:10,connection:{statement_timeout:15000}});
 return {
  async invoke(identity,tool,input,requestId){
   if(identity.issuer!==config.issuer)throw new Error('Invalid actor issuer');
   return sql.begin(async tx=>{
    await tx`select set_config('platform.actor_issuer',${config.issuer},true)`;
    const [row]=await tx`select crm_mcp.invoke(${identity.subject},${identity.clientId},${tool},${tx.json(input)},${requestId}::uuid) result`;
    return row.result;
   });
  },
  async knowledgeUploadTicket(identity,uploadId){
   if(identity.issuer!==config.issuer)throw new Error('Invalid actor issuer');
   return sql.begin(async tx=>{
    await tx`select set_config('platform.actor_issuer',${config.issuer},true)`;
    const [row]=await tx`select crm_mcp.knowledge_upload_ticket(${identity.subject},${identity.clientId},${uploadId}::uuid) ticket`;
    return row.ticket;
   });
  },
  async emailActionTicket(identity,tool,input,requestId){
   if(identity.issuer!==config.issuer)throw new Error('Invalid actor issuer');
   return sql.begin(async tx=>{
    await tx`select set_config('platform.actor_issuer',${config.issuer},true)`;
    const [row]=await tx`select crm_mcp.email_action_ticket(${identity.subject},${identity.clientId},${tool},${tx.json(input)},${requestId}::uuid) result`;
    return row.result;
   });
  },
  async voiceMediaTicket(identity,businessId,callId){
   if(identity.issuer!==config.issuer)throw new Error('Invalid actor issuer');
   return sql.begin(async tx=>{
    await tx`select set_config('platform.actor_issuer',${config.issuer},true)`;
    const [row]=await tx`select crm_mcp.voice_media_ticket(${identity.subject},${identity.clientId},${businessId},${callId}::uuid) ticket`;
    return row.ticket;
   });
  },
  async hostingTicket(identity,businessId,siteId,operationId){
   if(identity.issuer!==config.issuer)throw new Error('Invalid actor issuer');
   return sql.begin(async tx=>{
    await tx`select set_config('platform.actor_issuer',${config.issuer},true)`;
    const [row]=await tx`select crm_mcp.hosting_ticket(${identity.subject},${identity.clientId},${businessId},${siteId}::uuid,${operationId}::uuid) ticket`;
    return row.ticket;
   });
  },
  close:()=>sql.end({timeout:5}),
 };
}
