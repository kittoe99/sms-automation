(() => {
  function resize(event) {
    const data = event.data;
    if (!data || data.type !== 'sms-web-form:resize') return;
    document.querySelectorAll('iframe[data-sms-web-form]').forEach(frame => {
      const url = new URL(frame.src, document.baseURI);
      if (url.origin !== event.origin || url.searchParams.get('form') !== data.formId) return;
      const height = Number(data.height);
      if (Number.isFinite(height) && height >= 100 && height <= 5000) frame.style.height = `${height}px`;
    });
  }
  window.addEventListener('message', resize);
})();
