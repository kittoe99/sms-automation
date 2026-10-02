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
