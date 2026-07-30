/**
 * DigitalOcean Gradient™ AI agent client (OpenAI-compatible agent endpoint).
 * App Platform calls this; Supabase stays data-only.
 */

let cachedEndpoint;

export function isAiConfigured() {
  if (String(process.env.AI_ENABLED || 'true').toLowerCase() === 'false') return false;
  return Boolean(getAgentAccessKey() && getAgentEndpoint());
}

export function getAiConfig() {
  const categories = String(process.env.AI_ENABLED_CATEGORIES || 'quote-requests,appointment-reminders')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    enabled: isAiConfigured(),
    provider: 'digitalocean-gradient',
    endpoint: getAgentEndpoint(),
    model: String(process.env.GRADIENT_AGENT_MODEL || process.env.AI_MODEL || 'mistral-3-14B').trim(),
    agentUuid: String(process.env.GRADIENT_AGENT_UUID || '').trim() || null,
    maxHistory: Math.min(Math.max(Number(process.env.AI_MAX_HISTORY) || 20, 4), 40),
    enabledCategories: categories,
    maxReplyChars: Math.min(Math.max(Number(process.env.AI_MAX_REPLY_CHARS) || 320, 80), 600),
  };
}

export function getAgentAccessKey() {
  return String(
    process.env.GRADIENT_AGENT_ACCESS_KEY || process.env.AGENT_ACCESS_KEY || process.env.AI_API_KEY || ''
  ).trim();
}

export function getAgentEndpoint() {
  if (cachedEndpoint) return cachedEndpoint;
  const raw = String(
    process.env.GRADIENT_AGENT_ENDPOINT || process.env.AGENT_ENDPOINT || process.env.AI_BASE_URL || ''
  ).trim();
  if (!raw) return '';
  cachedEndpoint = raw.replace(/\/$/, '').replace(/\/api\/v1\/chat\/completions$/i, '');
  return cachedEndpoint;
}

/**
 * Chat completion against the provisioned Gradient agent endpoint.
 */
export async function gradientChat({ messages, maxTokens = 400 } = {}) {
  const endpoint = getAgentEndpoint();
  const apiKey = getAgentAccessKey();
  if (!endpoint || !apiKey) throw new Error('Gradient agent is not configured');

  const url = `${endpoint}/api/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages,
      stream: false,
      max_tokens: maxTokens,
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const detail = data?.message || data?.error || text || res.statusText;
    const err = new Error(`Gradient agent error (${res.status}): ${detail}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  const content = data?.choices?.[0]?.message?.content;
  return {
    content: content == null ? '' : String(content),
    model: data?.model || getAiConfig().model,
    usage: data?.usage || null,
    raw: data,
  };
}
