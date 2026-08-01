/**
 * Invite-only CRM auth (Supabase email/password).
 * Only emails in public.crm_admins can use the app.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';

let supabase = null;
let session = null;
let bootstrapped = false;

export function getSession() {
  return session;
}

export function getAccessToken() {
  return session?.access_token || null;
}

export function getSupabase() {
  return supabase;
}

export async function initAuth() {
  if (bootstrapped) return { session, configured: Boolean(supabase) };
  bootstrapped = true;

  const cfgRes = await fetch('/api/auth/config');
  const cfg = await cfgRes.json();
  if (!cfg?.configured || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error(
      'CRM auth is not configured on the server (missing SUPABASE_URL / SUPABASE_ANON_KEY).'
    );
  }

  supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  const { data } = await supabase.auth.getSession();
  session = data.session || null;

  supabase.auth.onAuthStateChange((_event, next) => {
    session = next;
  });

  return { session, configured: true };
}

export async function signIn(email, password) {
  if (!supabase) throw new Error('Auth not initialized');
  const { data, error } = await supabase.auth.signInWithPassword({
    email: String(email || '').trim(),
    password: String(password || ''),
  });
  if (error) throw new Error(error.message || 'Sign in failed');

  session = data.session;

  // Confirm allowlist via API (crm_admins).
  const me = await apiFetch('/api/auth/me');
  if (!me.ok) {
    const body = await me.json().catch(() => ({}));
    await supabase.auth.signOut();
    session = null;
    throw new Error(body.detail || body.error || 'This account is not invited to the SMS CRM.');
  }
  return data.session;
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
  session = null;
}

/**
 * fetch() wrapper that attaches the CRM access token.
 */
export async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...options, headers });
}

export function renderLoginScreen({ onSuccess, errorMessage = '' } = {}) {
  const root = document.getElementById('auth-root');
  const app = document.getElementById('crm-app');
  if (app) app.hidden = true;
  if (!root) return;

  root.hidden = false;
  root.innerHTML = `
    <div class="login-shell">
      <form class="login-card" id="login-form">
        <div class="login-brand">
          <span class="logo">Opek</span>
          <span class="logo-sub">SMS CRM</span>
        </div>
        <h1>Sign in</h1>
        <p class="muted">Invite-only access. Use your approved Opek email.</p>
        <label>
          Email
          <input id="login-email" type="email" autocomplete="username" required />
        </label>
        <label>
          Password
          <input id="login-password" type="password" autocomplete="current-password" required />
        </label>
        <p class="login-error" id="login-error">${escapeHtml(errorMessage)}</p>
        <button type="submit" class="btn" id="login-submit">Sign in</button>
        <p class="muted login-foot">Need access? Ask an admin to send an invite.</p>
      </form>
    </div>
  `;

  root.querySelector('#login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = root.querySelector('#login-error');
    const btn = root.querySelector('#login-submit');
    const email = root.querySelector('#login-email')?.value || '';
    const password = root.querySelector('#login-password')?.value || '';
    if (errEl) errEl.textContent = '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Signing in…';
    }
    try {
      await signIn(email, password);
      root.hidden = true;
      root.innerHTML = '';
      if (app) app.hidden = false;
      onSuccess?.();
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Sign in failed';
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    }
  });
}

export function showCrmApp() {
  const root = document.getElementById('auth-root');
  const app = document.getElementById('crm-app');
  if (root) {
    root.hidden = true;
    root.innerHTML = '';
  }
  if (app) app.hidden = false;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
