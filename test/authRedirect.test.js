import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrganizationChangeHandler } from '../public/auth.js';

test('sign-in and sign-out do not trigger a workspace reload', () => {
  let reloads = 0;
  const changed = createOrganizationChangeHandler(null, null, () => { reloads += 1; });
  changed({ session: { id: 'first' }, organization: { id: 'opek' } });
  changed({ session: { id: 'first' }, organization: { id: 'opek' } });
  changed({ session: null, organization: null });
  changed({ session: { id: 'second' }, organization: { id: 'opek' } });
  assert.equal(reloads, 0);
});

test('switching organizations within an active session reloads the workspace once', () => {
  let reloads = 0;
  const changed = createOrganizationChangeHandler('signed-in', 'opek', () => { reloads += 1; });
  changed({ session: { id: 'signed-in' }, organization: { id: 'bello' } });
  changed({ session: { id: 'signed-in' }, organization: { id: 'bello' } });
  assert.equal(reloads, 1);
});
