/** Legacy server adapter: AI execution is restricted to the dedicated AI worker. */
export function isAiConfigured() { return false; }
export function getAiConfig() { return {enabled:false,provider:'openai-worker',model:process.env.AI_MODEL || 'gpt-5.4-mini-2026-03-17',enabledCategories:[],maxHistory:20,maxReplyChars:600}; }
export async function workerOnlyChat() { throw new Error('AI execution requires the dedicated worker'); }
