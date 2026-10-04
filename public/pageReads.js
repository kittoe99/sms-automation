// Cancel unfinished page reads, while the render queue drains before repainting.
// Mutations are never aborted by navigation.
export function createPageReads(fetcher) {
  let controller = null;
  return {
    begin() { controller = new AbortController(); return controller; },
    end(scope) { if (controller === scope) controller = null; },
    cancel() { controller?.abort(); },
    async fetch(path, options = {}) {
      const scope = controller;
      const read = ['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase());
      if (!scope || !read) return fetcher(path, options);
      const signal = options.signal ? AbortSignal.any([scope.signal, options.signal]) : scope.signal;
      signal.throwIfAborted();
      const response = await fetcher(path, {...options, signal});
      signal.throwIfAborted();
      return response;
    },
  };
}

// Production /auth/me includes authorized workspaces. Older/local servers can
// still resolve them through /tenants. Never reuse context across sessions.
export async function readWorkspaceContext(fetcher, session) {
  if (Array.isArray(session?.tenants)) return session;
  const response = await fetcher('/api/tenants', {tenant: false});
  if (!response.ok) throw new Error('Could not load business accounts');
  return response.json();
}
