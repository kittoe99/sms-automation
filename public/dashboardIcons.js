// Shared silhouettes from E2local-main/app/dashboard/dashboard-artwork.tsx.
const artwork = {
  overview: '<path d="M3 3h7v10H3zM14 3h7v6h-7zM3 17h7v4H3z"/><path d="M14 13h7v8h-7z"/>',
  contacts: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2z"/>',
  messaging: '<path d="M3 4h18v13H9l-6 4zM7 9h10M7 13h6"/>',
  bookings: '<path d="M3 5h18v16H3zM3 10h18M7 3v4M17 3v4m-9 8 3 3 5-5"/>',
  forms: '<path d="M3 4h13v16H3zM6 8h6M6 12h3M13 15h8m-3-3 3 3-3 3M6 16h2"/>',
  voice: '<rect x="8" y="3" width="8" height="13" rx="4"/><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M9 22h6"/>',
  reports: '<path d="M4 3v18h17M8 16v-4M13 16V8M18 16V4"/>',
  setup: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
  platform: '<path d="M3 4h18v16H3zM3 9h18M8 9v11M12 13h5M12 16h3"/>',
  twilio: '<circle cx="12" cy="12" r="9"/><path d="M8 8h1v1H8zM15 8h1v1h-1zM8 15h1v1H8zM15 15h1v1h-1z"/>',
};

export function dashboardIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${artwork[name] || artwork.overview}</svg>`;
}
