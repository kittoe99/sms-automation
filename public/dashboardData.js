export async function readDashboard(fetcher, loadCategories, onTotals) {
  const read = async path => {
    const response = await fetcher(path);
    if (!response.ok) throw Object.assign(new Error('Could not load dashboard data'), {status:response.status});
    return response.json();
  };
  const [totals, connection, categories, forms] = await Promise.allSettled([
    read('/api/overview').then(data => { onTotals?.(data); return data; }),
    read('/api/sms/connection'),
    loadCategories(),
    read('/api/web-forms'),
  ]);
  for (const result of [totals, connection, categories, forms]) {
    if (result.status === 'rejected' && result.reason?.name === 'AbortError') throw result.reason;
  }
  if (totals.status === 'rejected' && [401,403].includes(totals.reason?.status)) throw totals.reason;
  if (categories.status === 'rejected') throw categories.reason;
  return {data:totals.status === 'fulfilled' ? totals.value : {},
    formsData:forms.status === 'fulfilled' ? forms.value : null,
    totalsAvailable:totals.status === 'fulfilled',
    smsConnection:connection.status === 'fulfilled' ? connection.value : null};
}
