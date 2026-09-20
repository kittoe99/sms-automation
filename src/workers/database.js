import postgres from 'postgres';
const functions = new Set(['claim','extend_lease','finish','begin_submission','accept_submission','job_context','draft_job_context','complete_automation_draft','fail_automation_draft','provision_credentials','complete_automation','complete_ai','ai_tool','provision_checkpoint','api_action','api_read','provider_setup','save_provider_setup','queue_provision','webhook_credentials','record_webhook','integration_credentials','ingest_event','knowledge_job_context','complete_knowledge_ingest','complete_embeddings','fail_knowledge_job','search_job_knowledge','complete_grounded_ai','handoff_job_context','complete_handoff_alert','compliance_job_context','compliance_checkpoint','queue_activation_canary']);
export function connectDatabase(url = process.env.WORKER_DATABASE_URL) {
  if (!url) throw new Error('WORKER_DATABASE_URL is required (a scoped worker login)');
  const poolSize=Math.min(12,Math.max(1,Number(process.env.WORKER_DB_POOL_SIZE)||12));
  const sql = postgres(url, { ssl: process.env.NODE_ENV === 'test' ? false : 'require', prepare: false, max: poolSize, connect_timeout: 10, idle_timeout: 20 });
  return {
    async call(name, ...args) {
      if (!functions.has(name)) throw new Error('Unknown database operation');
      const values = args;
      const result = await sql.unsafe(`select sms_private.${name}(${values.map((_,i)=>`$${i+1}`).join(',')}) as result`, values);
      return result[0]?.result;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
