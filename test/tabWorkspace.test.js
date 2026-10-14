import test from 'node:test';
import assert from 'node:assert/strict';
import {createRenderQueue, createTabMemory, resetWorkspaceState, createCompletionGuard} from '../public/tabWorkspace.js';

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

test('account and business reset removes every retained editor and selected record',()=>{
  const state={view:'business-context',pageSize:50,tenant:{id:'alpha'},tenants:[{id:'alpha'}],
    businessContextDraft:{name:'Account A draft'},bookingSettingsDraft:{services:['A service']},
    setupOnboarding:{secret:'A'},setupProvisioning:{id:'A'},setupRegistration:{id:'A'},
    voiceBookingDrafts:{A:{name:'A'}},voiceWorkspace:{agentId:'A'},inboundVoiceWorkspace:{draft:'A'},
    conversationPhone:'+13035550123',conversationId:'A',selected:{id:'A'},categories:[{id:'A'}],
    automationBuilderOpen:true,automationPresetId:'A',emailGroupId:'A',q:'A contact'};
  resetWorkspaceState(state);
  assert.equal(state.businessContextDraft,null);assert.equal(state.bookingSettingsDraft,null);
  for(const field of ['tenant','setupOnboarding','setupProvisioning','setupRegistration','conversationPhone','conversationId','selected','automationPresetId','emailGroupId'])assert.equal(state[field],null,field);
  for(const field of ['voiceBookingDrafts','voiceWorkspace','inboundVoiceWorkspace'])assert.deepEqual(state[field],{},field);
  assert.deepEqual(state.tenants,[]);assert.deepEqual(state.categories,[]);assert.equal(state.q,'');
  assert.equal(state.automationBuilderOpen,false);assert.equal(state.view,'business-context');assert.equal(state.pageSize,50);
});

test('late write completions cannot repaint a different page or overwrite another business draft',async()=>{
  let context=['session-a','user-a','alpha','business-context'],mounted=true;
  const isCurrent=createCompletionGuard(()=>context,()=>mounted);
  let release;const response=new Promise(resolve=>{release=resolve;});
  const draft={name:'Beta draft'};let painted=false;
  const save=response.then(()=>{if(!isCurrent())return;draft.name='Alpha saved';painted=true;});
  context=['session-a','user-a','beta','business-context'];release();await save;
  assert.equal(draft.name,'Beta draft');assert.equal(painted,false);
  context=['session-a','user-a','alpha','business-context'];assert.equal(isCurrent(),true);
  context[3]='contacts';assert.equal(isCurrent(),false);
  context[3]='business-context';mounted=false;assert.equal(isCurrent(),false);
  mounted=true;context[0]='session-b';assert.equal(isCurrent(),false);
});
