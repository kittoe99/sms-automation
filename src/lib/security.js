import { createHash } from 'node:crypto';
import { getClerkFrontendApiUrl } from './crmAuth.js';

/** Compare secrets without leaking their length or mismatch position. */
export function constantTimeEqual(left, right) {
  const leftDigest = createHash('sha256').update(String(left ?? ''), 'utf8').digest();
  const rightDigest = createHash('sha256').update(String(right ?? ''), 'utf8').digest();
  return leftDigest.equals(rightDigest);
}

/** Basic hardening headers without introducing a runtime dependency. */
export function securityHeaders(req, res, next) {
  const connectSources = ["'self'"];
  const clerkScriptSources = [
    "'self'",
    'https://challenges.cloudflare.com',
    'https://*.protect.clerk.com',
  ];
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim();
  try {
    if (publicBaseUrl) {
      const publicOrigin = new URL(publicBaseUrl).origin;
      connectSources.push(publicOrigin.replace(/^http/i, 'ws'));
    } else if (process.env.NODE_ENV !== 'production' && req.get('host')) {
      const websocketScheme = req.protocol === 'https' ? 'wss' : 'ws';
      connectSources.push(`${websocketScheme}://${req.get('host')}`);
    }
  } catch {
    // Health checks report invalid/missing production configuration separately.
  }
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  try {
    if (supabaseUrl) {
      const origin = new URL(supabaseUrl).origin;
      connectSources.push(origin, origin.replace(/^http/i, 'ws'));
    }
  } catch {
    // Health checks report invalid/missing production configuration separately.
  }
  const clerkFrontendOrigin = getClerkFrontendApiUrl();
  if (clerkFrontendOrigin) {
    connectSources.push(clerkFrontendOrigin);
    clerkScriptSources.push(clerkFrontendOrigin);
  }
  connectSources.push(
    'https://*.protect.clerk.com:*',
    'https://clerk-telemetry.com',
    'https://*.clerk-telemetry.com'
  );

  const policy = [
    "default-src 'self'",
    `script-src ${clerkScriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://img.clerk.com",
    "font-src 'self'",
    `connect-src ${connectSources.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (process.env.NODE_ENV === 'production') policy.push('upgrade-insecure-requests');

  res.setHeader('Content-Security-Policy', policy.join('; '));
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
  );
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path === '/health' || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

export function redactPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : null;
}

export function createRateLimiter({ windowMs, max, key = (req) => req.ip || 'unknown' }) {
  const buckets = new Map();
  let calls = 0;
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = String(key(req) || 'unknown').slice(0, 256);
    const current = buckets.get(bucketKey);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;
    bucket.count += 1;
    buckets.set(bucketKey, bucket);

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Too many requests' });
    }

    calls += 1;
    if (calls % 500 === 0) {
      for (const [id, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(id);
      }
    }
    return next();
  };
}
