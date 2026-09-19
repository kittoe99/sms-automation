/** The Express-era agent is retired. Inbound AI is persisted and queued by the Supabase webhook. */
export async function processInboundAiJob() { return {skipped:true,reason:'supabase_worker_only'}; }

export async function drainInboundAiJobs({ limit = 25, now = new Date() } = {}) {
  return {processed:0,completed:0,skipped:1,errors:[],reason:'supabase_worker_only'};
}
