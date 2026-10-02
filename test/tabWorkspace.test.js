import test from 'node:test';
import assert from 'node:assert/strict';
import {createRenderQueue, createTabMemory} from '../public/tabWorkspace.js';

test('a slow render completes before navigation can replace its root', async () => {
  const queue = createRenderQueue();
  let release;
  const network = new Promise(resolve => { release = resolve; });
  const events = [];
  const render = queue.run(async () => { events.push('load A'); await network; events.push('paint A'); });
  const navigate = queue.run(() => { events.push('activate B'); });
  await Promise.resolve();
  assert.deepEqual(events, ['load A']);
  release(); await Promise.all([render, navigate]);
  assert.deepEqual(events, ['load A', 'paint A', 'activate B']);
});

test('a failed request does not prevent subsequent tab navigation', async () => {
  const queue = createRenderQueue();
  await assert.rejects(queue.run(() => { throw new Error('offline'); }), /offline/);
  assert.equal(await queue.run(() => 'next tab'), 'next tab');
});

test('retained drafts preserve object identity and updates do not discard them; workspace reset clears all', () => {
  const memory = createTabMemory();
  const draft = {value: 'Unsaved customer reply'};
  const snapshot = {nodes: [draft], state: {page: 3}, stale: false};
  memory.save('inbox', snapshot);
  memory.markStale();
  const restored = memory.take('inbox');
  assert.equal(restored.nodes[0], draft);
  assert.equal(restored.state.page, 3);
  assert.equal(restored.stale, true);
  assert.equal(memory.take('inbox'), undefined);
  memory.save('inbox', restored); memory.save('contacts', {nodes: []});
  memory.clear();
  assert.equal(memory.take('inbox'), undefined);
  assert.equal(memory.take('contacts'), undefined);
});
