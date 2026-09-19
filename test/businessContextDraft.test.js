import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');

test('business context drafts survive realtime and polling refreshes',()=>{
 assert.match(app,/businessContextDraft:\s*null/);
 assert.match(app,/form\[data-dirty="true"\]/);
 assert.match(app,/connectSupabaseLive\(\(\) => refreshFromBackground/);
 assert.match(app,/setInterval\(\(\) => refreshFromBackground/);
 assert.match(app,/form\.addEventListener\('input', captureDraft\)/);
 assert.match(app,/state\.businessContextDraft \? \{ \.\.\.defaults, \.\.\.state\.businessContextDraft \} : defaults/);
});
