/** Clerk-backed CRM authentication and tenant request context. */

let clerk = null;
export const runtimeConfig = globalThis.SMS_CONFIG || {};
export const apiUrl = url => runtimeConfig.apiBase && url.startsWith('/api/')
  ? runtimeConfig.apiBase.replace(/\/$/, '') + url.slice(4) : url;
let demoMode = false;
let localMode = false;
let bootstrapped = false;
const requestKeys = new Map();
let loginNode = null;
let loginUnsubscribe = null;
let organizationSwitcherNode = null;
const TENANT_STORAGE_KEY = 'opek_sms_tenant_id';
const DEMO_TENANT_STORAGE_KEY = 'opek_sms_demo_tenant_id';

export function isDemoMode() {
  return demoMode;
}

const clerkAppearance = {
  theme: 'simple',
  captcha: { theme: 'light' },
  variables: {
    colorPrimary: '#087f5b',
    colorBackground: '#ffffff',
    colorForeground: '#182a23',
    colorInputBackground: '#ffffff',
    colorInputText: '#182a23',
    colorText: '#182a23',
    colorTextSecondary: '#596b63',
    colorDanger: '#bd3445',
    borderRadius: '0px',
    fontFamily: 'Manrope, Arial, sans-serif',
  },
  elements: {
    cardBox: { width: 'min(100%, 430px)' },
    card: {
      border: '1px solid #d7e1dc',
      background: '#ffffff',
      boxShadow: '0 20px 60px rgba(24, 42, 35, 0.1)',
    },
    formButtonPrimary: {
      background: '#087f5b',
      color: '#ffffff',
      boxShadow: '0 8px 20px rgba(8, 127, 91, 0.15)',
      fontWeight: '800',
    },
    formFieldInput: {
      border: '1px solid #d7e1dc',
      background: '#ffffff',
      boxShadow: 'none',
    },
    footerActionLink: { color: '#087f5b', fontWeight: '800' },
  },
};

export function getTenantId() {
  try {
    return localStorage.getItem(demoMode ? DEMO_TENANT_STORAGE_KEY : TENANT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setTenantId(tenantId) {
  const value = String(tenantId || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error('Invalid business account identifier');
  }
  localStorage.setItem(demoMode ? DEMO_TENANT_STORAGE_KEY : TENANT_STORAGE_KEY, value);
}

export function getSession() {
  if (localMode) return { id: 'local-development', user: { id: 'local-developer', name: 'Local developer', email: '' } };
  if (!clerk?.user || !clerk?.session) return null;
  const email = clerk.user.primaryEmailAddress?.emailAddress ||
    clerk.user.emailAddresses?.[0]?.emailAddress || '';
  return {
    id: clerk.session.id,
    user: {
      id: clerk.user.id,
      email,
      name: clerk.user.fullName || clerk.user.firstName || email,
      imageUrl: clerk.user.imageUrl || null,
    },
    organization: clerk.organization
      ? { id: clerk.organization.id, name: clerk.organization.name, slug: clerk.organization.slug }
      : null,
  };
}

export async function getAccessToken() {
  if (localMode) return 'local-development';
  return clerk?.session ? clerk.session.getToken() : null;
}

export async function initAuth() {
  if (bootstrapped) return { session: getSession(), configured: Boolean(clerk), demo: demoMode };
  bootstrapped = true;

  const cfgRes = await fetch(apiUrl('/api/auth/config'));
  if (!cfgRes.ok) throw new Error('Could not load authentication configuration.');
  const cfg = await cfgRes.json();
  const addBusinessButton = document.getElementById('add-business');
  if (addBusinessButton) addBusinessButton.hidden = cfg.manualBusinesses !== true;
  if (cfg?.mode === 'local') {
    localMode = true;
    document.getElementById('sign-out-btn')?.setAttribute('hidden', '');
    return { session: getSession(), configured: true };
  }
  if (cfg?.mode === 'demo' && cfg.demo === true) {
    demoMode = true;
    return { session: null, configured: false, demo: true };
  }
  if (!cfg?.configured || !cfg.publishableKey) {
    throw new Error(
      'CRM auth is not configured on the server (missing CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY).'
    );
  }

  const clerkOrigin = getClerkOrigin(cfg.frontendApiUrl);
  await loadScript(`${clerkOrigin}/npm/@clerk/ui@1/dist/ui.browser.js`);
  await loadScript(`${clerkOrigin}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
    'data-clerk-publishable-key': cfg.publishableKey,
  });

  clerk = globalThis.Clerk;
  if (!clerk || typeof clerk.load !== 'function') {
    throw new Error('The Clerk authentication client failed to load.');
  }
  await clerk.load({
    appearance: clerkAppearance,
    ui: { ClerkUI: globalThis.__internal_ClerkUICtor },
  });
  let activeOrganizationId = clerk.organization?.id || null;
  clerk.addListener(({ organization }) => {
    const nextOrganizationId = organization?.id || null;
    if (nextOrganizationId !== activeOrganizationId) {
      activeOrganizationId = nextOrganizationId;
      window.dispatchEvent(new CustomEvent('clerk:organization-changed'));
    }
  });
  return { session: getSession(), configured: true };
}

export async function signOut() {
  if (clerk) await clerk.signOut({ redirectUrl: '/' });
}

/** fetch() wrapper that attaches the current Clerk session token. */
export async function apiFetch(url, options = {}) {
  if (demoMode && !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase())) {
    return new Response(JSON.stringify({ error: 'Read-only demo: changes, SMS, and calls are disabled.' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }
  const { tenant = true, ...fetchOptions } = options;
  const headers = new Headers(options.headers || {});
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const tenantId = getTenantId();
  if (tenant && tenantId) headers.set('X-Tenant-ID', tenantId);
  if (options.body && !headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const mutation = String(options.method || 'GET').toUpperCase() === 'POST';
  const fingerprint = `${tenantId}:${url}:${options.body || ''}`;
  if (mutation && !headers.has('Idempotency-Key')) {
    if (!requestKeys.has(fingerprint)) requestKeys.set(fingerprint, crypto.randomUUID());
    headers.set('Idempotency-Key', requestKeys.get(fingerprint));
  }
  const response = await fetch(apiUrl(url), { ...fetchOptions, headers });
  if (response.ok || (response.status >= 400 && response.status < 500)) requestKeys.delete(fingerprint);
  return response;
}

export function renderLoginScreen({ onSuccess, errorMessage = '' } = {}) {
  const root = document.getElementById('auth-root');
  const app = document.getElementById('crm-app');
  if (app) app.hidden = true;
  if (!root) return;

  unmountLogin();
  root.hidden = false;
  root.innerHTML = `
    <div class="login-shell">
      <div class="clerk-login-wrap">
        <div class="login-brand">
          <span class="logo">Opek</span>
          <span class="logo-sub">SMS CRM</span>
        </div>
        <p class="login-error">${escapeHtml(errorMessage)}</p>
        <div id="clerk-sign-in"></div>
      </div>
    </div>
  `;

  loginNode = root.querySelector('#clerk-sign-in');
  if (!clerk || !loginNode) return;

  let completed = false;
  loginUnsubscribe = clerk.addListener(({ user, session }) => {
    if (!user || !session || completed) return;
    completed = true;
    showCrmApp();
    Promise.resolve(onSuccess?.()).catch((err) => {
      renderLoginScreen({ onSuccess, errorMessage: err?.message || 'Could not open the CRM.' });
    });
  });
  clerk.mountSignIn(loginNode, {
    appearance: clerkAppearance,
    routing: 'hash',
    forceRedirectUrl: '/',
    withSignUp: false,
  });
}

export function showCrmApp() {
  const root = document.getElementById('auth-root');
  const app = document.getElementById('crm-app');
  unmountLogin();
  if (root) {
    root.hidden = true;
    root.innerHTML = '';
  }
  if (app) app.hidden = false;
  mountOrganizationSwitcher();
}

function unmountLogin() {
  if (loginUnsubscribe) loginUnsubscribe();
  loginUnsubscribe = null;
  if (clerk && loginNode) {
    try {
      clerk.unmountSignIn(loginNode);
    } catch {
      // The host node may already have been removed during navigation.
    }
  }
  loginNode = null;
}

function mountOrganizationSwitcher() {
  const node = document.getElementById('clerk-organization-switcher');
  if (!clerk || !node || organizationSwitcherNode === node) return;
  organizationSwitcherNode = node;
  clerk.mountOrganizationSwitcher(node, { hidePersonal: true });
}

function getClerkOrigin(frontendApiUrl) {
  try {
    const url = new URL(frontendApiUrl);
    if (url.protocol !== 'https:' || !url.hostname) throw new Error('Invalid Clerk domain');
    return url.origin;
  } catch {
    throw new Error('The Clerk Frontend API URL is invalid.');
  }
}

function loadScript(src, attributes = {}) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('Could not load Clerk. Check the publishable key and network.')),
      { once: true }
    );
    document.head.appendChild(script);
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
