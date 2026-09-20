import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');

test('business context drafts survive realtime and polling refreshes',()=>{
 assert.match(app,/businessContextDraft:\s*null/);
 assert.match(app,/form\[data-dirty="true"\]/);
 assert.match(app,/connectSupabaseLive\(\(\) => refreshFromBackground/);
 assert.match(app,/setInterval\(\(\) => refreshFromBackground/);
 assert.match(app,/form\.addEventListener\('input', captureDraft\)/);
  assert.match(app,/state\.businessContextDraft \? \{ \.\.\.defaults, \.\.\.state\.businessContextDraft \} : defaults/);
});

test('business context always refetches server truth and shouts about device-only saves',()=>{
  assert.match(app,/known-good server copy/);
  assert.match(app,/Saved on this device only/);
  assert.match(app,/will NOT see it/);
});

test('business context website enrichment prefers the project Firecrawl endpoint',()=>{
  const handlerStart=app.indexOf("const payload = JSON.stringify({ websiteUrl: url })");
  const localFetch=app.indexOf("fetch('/api/enrich-website'",handlerStart);
  const hostedFallback=app.indexOf("apiFetch('/api/enrich-website'",handlerStart);
  assert.ok(handlerStart >= 0);
  assert.ok(localFetch > handlerStart);
  assert.ok(hostedFallback > localFetch);
  assert.doesNotMatch(app,/Replace the form contents with freshly fetched website details/);
});

test('business context and AI knowledge share one navigation destination',()=>{
  assert.match(app,/id="business-knowledge"/);
  assert.match(app,/mountKnowledgePanel\(\)/);
  assert.doesNotMatch(html,/data-view="knowledge"/);
  assert.match(html,/data-view="business-context"[^>]+knowledge sources documents/);
});
