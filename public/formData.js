// Short-lived cache owned by one Forms workspace, never shared between users.
export function createFormData(fetcher, getScope) {
  let scope;
  const entries = new Map();
  function clear() { entries.clear(); }
  function checkScope() {
    const next = getScope();
    if (scope !== next) { clear(); scope = next; }
  }
  async function fetch(path, options = {}) {
    checkScope();
    const response = await fetcher(path, options);
    if (response.ok && !['GET','HEAD'].includes((options.method || 'GET').toUpperCase())) clear();
    return response;
  }
  function read(path, {fresh = false} = {}) {
    checkScope();
    if (fresh) entries.delete(path);
    if (!entries.has(path)) {
      const pending = fetch(path).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load forms');
        return data;
      });
      entries.set(path, pending);
      pending.catch(() => { if (entries.get(path) === pending) entries.delete(path); });
    }
    return entries.get(path);
  }
  return {read, fetch, clear};
}
