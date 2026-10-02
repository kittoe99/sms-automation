import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('dashboard follow-ups use compact status cards instead of disclosure rows', () => {
  assert.match(app, /class="card followup-section"/);
  assert.match(app, /class="followup-grid"/);
  assert.match(app, /class="followup-state \$\{active \? 'is-active' : 'is-paused'\}"/);
  assert.match(app, /class="card automation-health"/);
  assert.doesNotMatch(app, /<details><summary>Details<\/summary>/);
  assert.match(app, /const sendLabel = sendCount \?/);
  assert.match(css, /\.followup-card\s*\{/);
  assert.match(css, /\.automation-health\s*>\s*summary\s*\{/);
});
