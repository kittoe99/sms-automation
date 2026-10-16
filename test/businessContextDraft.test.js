import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const navigation=readFileSync(new URL('../public/workspaceNavigation.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');

test('business context drafts survive realtime and polling refreshes',()=>{
 assert.match(app,/businessContextDraft:\s*null/);
 assert.match(app,/form\[data-dirty="true"\]/);
 assert.match(app,/connectSupabaseLive\(\(\) => refreshFromBackground/);
 assert.match(app,/setInterval\(\(\) => refreshFromBackground/);
 assert.match(app,/state\.businessContextDraft=profileFromForm\(new FormData\(form\),profile\)/);
  assert.match(app,/const profile=\{\.\.\.saved\.onboarding,\.\.\.state\.businessContextDraft\}/);
});

test('business context uses the shared draft and review workflow without local success fallback',()=>{
  assert.match(app,/saved=await fetchOnboarding\(\)/);
  assert.match(app,/writeBusinessProfile\(apiFetch, payload, state.setupOnboarding\?\.revision, intent\)/);
  assert.match(app,/Save business info/);
  assert.doesNotMatch(app,/Saved on this device only/);
});

test('business context saves the shared document editor through explicit draft or review',()=>{
 assert.match(app,/profileEditorHtml\(profile\)/);
 assert.match(app,/editor\.prepare\(intent==='review'\)/);
 assert.match(app,/saveOnboarding\(payload,intent\)/);
 assert.match(app,/Draft saved. AI continues using the reviewed version/);
 assert.doesNotMatch(app,/fetch\('\/api\/enrich-website'/);
});

test('business context and AI knowledge share one navigation destination',()=>{
  assert.match(app,/id="business-knowledge"/);
  assert.match(app,/mountKnowledgePanel\(\)/);
  assert.doesNotMatch(html,/data-view="knowledge"/);
  assert.match(navigation,/item\('business-context','Business information','[^']*knowledge/);
});
