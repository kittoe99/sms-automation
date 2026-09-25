import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldRefreshFromBackground} from '../public/refreshGuard.js';

test('background updates leave automation and AI settings editors mounted', () => {
  const idle = {view:'automations',automationBuilderOpen:false,aiBuilderOpen:false,
    focusedInForm:false,hasDirtyForm:false};
  assert.equal(shouldRefreshFromBackground(idle),true);
  assert.equal(shouldRefreshFromBackground({...idle,automationBuilderOpen:true}),false);
  assert.equal(shouldRefreshFromBackground({...idle,aiBuilderOpen:true}),false);
  assert.equal(shouldRefreshFromBackground({...idle,view:'ai-instructions'}),false);
  assert.equal(shouldRefreshFromBackground({...idle,focusedInForm:true}),false);
  assert.equal(shouldRefreshFromBackground({...idle,hasDirtyForm:true}),false);
});

