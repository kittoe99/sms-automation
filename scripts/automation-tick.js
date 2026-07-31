#!/usr/bin/env node
/**
 * DigitalOcean scheduled job entrypoint — runs Quote Request drip tick.
 * Prefer direct runner (same env as API); falls back to HTTP if AUTOMATION_TICK_URL is set.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

async function main() {
  const url = String(process.env.AUTOMATION_TICK_URL || '').trim();
  if (url) {
    const key = String(process.env.OPEK_SMS_API_KEY || '').trim();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'X-API-Key': key } : {}),
      },
      body: '{}',
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('[automation-tick] HTTP failed', res.status, text);
      process.exit(1);
    }
    console.log('[automation-tick]', text);
    return;
  }

  const { runAutomationTick } = await import('../src/lib/automations/runner.js');
  const summary = await runAutomationTick();
  console.log('[automation-tick]', JSON.stringify(summary));
  if (summary.errors?.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[automation-tick] fatal', err);
  process.exit(1);
});
