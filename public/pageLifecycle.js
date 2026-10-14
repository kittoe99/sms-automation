export function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once:true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

// A mounted page owns its reads. Leaving cancels reads, while submitted writes
// may finish independently and never hold navigation open.
export function createPageLifecycle({isCurrent = () => true, timeoutMs = 30_000} = {}) {
  let controller = new AbortController(), active = true;
  const current = () => active && !controller.signal.aborted && isCurrent();
  const suspend = () => {active = false;controller.abort();};
  const resume = () => {if (!active || controller.signal.aborted) controller = new AbortController();active = true;};
  const begin = () => {controller.abort();controller = new AbortController();active = true;};
  async function read(callback, signal) {
    const owner = controller;
    const requestSignal = AbortSignal.any([owner.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const check = () => {
      requestSignal.throwIfAborted();
      if (!active || owner !== controller || !isCurrent()) throw new DOMException('Page changed', 'AbortError');
    };
    check();
    const result = await abortable(callback(requestSignal), requestSignal);
    check();
    return result;
  }
  return {current, suspend, resume, begin, read};
}

// One upload batch can outlive its mounted page; its own deadline still bounds
// work. On failure, stop the remaining workers before reporting the error.
export async function uploadFiles(uploads, files, {fetcher = fetch, concurrency = 4, timeoutMs = 120_000, onProgress = () => {}} = {}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  const byPath = new Map(files.map(file => [file.path, file.file]));
  let next = 0, failure;
  async function worker() {
    while (next < uploads.length && !failure) {
      const upload = uploads[next++];
      try {
        signal.throwIfAborted();
        const file = byPath.get(upload.path);
        if (!file) throw new Error('The upload manifest contains an unknown file.');
        const response = await abortable(fetcher(upload.url, {method:'PUT', headers:{'Content-Type':upload.contentType}, body:file, signal}), signal);
        if (!response.ok) throw new Error('Upload failed. Check R2 upload CORS and retry with a new version.');
        onProgress(upload.path);
      } catch (error) {failure ||= error;controller.abort(error);}
    }
  }
  await Promise.all(Array.from({length:Math.min(uploads.length, Math.max(1, concurrency))}, worker));
  if (failure) throw failure;
}
