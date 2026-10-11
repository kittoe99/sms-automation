const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Matches E2 Local's DashboardLoader, including its reduced-motion treatment.
export function dashboardLoader(label = 'Loading…', compact = false) {
  return `<span class="crm-loader${compact ? ' crm-loader-compact' : ''}" role="status" aria-label="${escape(label)}"><span class="crm-loader-ring" aria-hidden="true"></span><span class="crm-loader-label" aria-hidden="true">${escape(label)}</span></span>`;
}
