// Retain actual nodes so form values, listeners and expanded details survive a
// tab switch. Nothing is persisted across reloads, sign-outs or workspaces.
export function createTabMemory() {
  const tabs = new Map();
  return {
    save(key, snapshot) { tabs.set(key, snapshot); },
    take(key) { const snapshot = tabs.get(key); tabs.delete(key); return snapshot; },
    clear() { tabs.clear(); },
    markStale() { for (const snapshot of tabs.values()) snapshot.stale = true; },
  };
}

// These pages dispose timers/media on departure. Save their data model, never
// DOM handlers closing over a disposed controller.
export const retainsMountedTab = view => !['automation-activity','voice-agent','call'].includes(view);

// Used for every account/business reset, including Clerk multi-session switches.
export function resetWorkspaceState(state) {
  Object.assign(state, {
    tenant:null,tenants:[],categoryId:null,q:'',status:'',page:1,totalPages:1,
    categories:[],cadences:[],rulePresets:[],selected:null,
    setupProvisioning:null,setupOnboarding:null,setupRegistration:null,
    businessContextDraft:null,bookingSettingsDraft:null,voiceBookingDrafts:{},
    voiceWorkspace:{},inboundVoiceWorkspace:{},conversationPhone:null,conversationId:null,
    automationBuilderOpen:false,automationPresetId:null,aiBuilderOpen:false,emailGroupId:null,
    unreadOnly:false,contactStatus:'',sourceFilter:'',consentedOnly:false,bookingStatus:'',
  });
}

// Submitted writes may finish after navigation. Their completion may only touch
// the same mounted editor and authorized workspace that started the operation.
export function createCompletionGuard(context, mounted) {
  const started=JSON.stringify(context());
  return ()=>mounted()&&JSON.stringify(context())===started;
}

// Legacy renderers share a visible root. Serialize work before changing the
// active tab, so a slow response cannot paint into a different tab.
export function createRenderQueue() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(task);
      tail = result.catch(() => {});
      return result;
    },
  };
}
