/**
 * Business-website enrichment, mirroring the Get Started site-read in
 * wpacquisition-main (Firecrawl scrape + JSON extraction, plain-HTML fallback).
 *
 * Dependency-free ESM so both the legacy Express server (Node) and Supabase
 * Edge functions (Deno) can import it. The Firecrawl key is always passed in
 * by the caller — never read from the environment here.
 */

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';

const EXTRACT_PROMPT =
  'Extract the business facts visible on this page for an SMS business profile. ' +
  'Return the legal or brand business name, a one or two sentence summary of what the business does, ' +
  'the list of services a customer could hire, the cities/regions served, the main contact phone number, ' +
  'and the business hours exactly as written. Use empty strings and empty arrays when a fact is not visible. ' +
  'Never invent services, cities, hours, or phone numbers.';

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    businessName: { type: 'string' },
    summary: { type: 'string' },
    services: { type: 'array', items: { type: 'string' } },
    locations: { type: 'array', items: { type: 'string' } },
    phoneNumber: { type: 'string' },
    hours: { type: 'string' },
  },
};

const NAV_JUNK = new Set(
  ['home', 'about', 'about us', 'contact', 'contact us', 'menu', 'blog', 'faq', 'faqs', 'reviews',
    'testimonials', 'gallery', 'services', 'our services', 'all services', 'read more', 'learn more',
    'get started', 'get a quote', 'book now', 'call now', 'privacy policy', 'terms of service'].map((s) => s.toLowerCase())
);

function fail(message, status = 502) {
  throw Object.assign(new Error(message), { status });
}

/** Normalize a user-entered domain into an https URL. Rejects non-public hosts. */
export function normalizeWebsiteUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) fail('Enter a website address.', 400);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  if (value.length > 2048) fail('Enter a valid website address.', 400);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('Enter a valid website address.', 400);
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail('Enter a valid website address.', 400);
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
    host === '0.0.0.0' || host.startsWith('127.') || host === '::1' ||
    host.startsWith('10.') || host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    fail('Enter a valid website address.', 400);
  }
  url.protocol = 'https:';
  return url.href;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function metaContent(html, names) {
  for (const name of names) {
    const match = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'iu'))
      ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["']`, 'iu'));
    if (match?.[1]) return decodeEntities(match[1]).trim();
  }
  return '';
}

function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/?(h[1-4]|p|li|br|div|section|tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 12000);
}

function uniqueCapped(values, max, maxLen) {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const value = stripTags(raw).replace(/\s+/g, ' ').trim();
    if (!value || value.length > maxLen) continue;
    const key = value.toLowerCase();
    if (NAV_JUNK.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function extractPhone(text, html) {
  if (html) {
    for (const match of String(html).matchAll(/href=["']tel:([^"']+)["']/gi)) {
      let value = match[1] || '';
      try {
        value = decodeURIComponent(value);
      } catch {
        // Keep the literal href when it is not URI encoded.
      }
      const phone = (value.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/) || [])[0];
      if (phone) return phone.replace(/\s+/g, ' ').slice(0, 32);
    }
  }
  const phone = (String(text || '').match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/) || [])[0];
  return phone ? phone.replace(/\s+/g, ' ').slice(0, 32) : '';
}

function extractHours(text) {
  const found = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 160) continue;
    if (/24\s*\/\s*7|24\s*hours?/i.test(trimmed)) {
      found.push('Open 24 hours');
      continue;
    }
    if (/(mon|tue|wed|thu|fri|sat|sun)/i.test(trimmed) && /(\d{1,2}(:\d{2})?\s*(am|pm)|closed|open)/i.test(trimmed)) {
      found.push(trimmed.slice(0, 160));
    } else if (/^(hours?|open|business hours?)\b/i.test(trimmed) && /\d/.test(trimmed)) {
      found.push(trimmed.slice(0, 160));
    }
    if (found.length >= 3) break;
  }
  return [...new Set(found)].join('; ').slice(0, 200);
}

function jsonLdValues(html) {
  const names = [];
  const localities = [];
  const phones = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const type = Array.isArray(node['@type']) ? node['@type'].map(String).join(' ') : String(node['@type'] ?? '');
    if (/\b(Service|Offer|Product|Procedure)\b/i.test(type) && typeof node.name === 'string') names.push(node.name);
    if (/\b(LocalBusiness|Organization|Store)\b/i.test(type)) {
      const address = node.address && typeof node.address === 'object' ? node.address : null;
      const locality = address ? [address.addressLocality, address.addressRegion].filter((v) => typeof v === 'string') : [];
      localities.push(...locality);
      if (typeof node.telephone === 'string') phones.push(node.telephone);
    }
    if (Array.isArray(node.itemListElement)) {
      for (const item of node.itemListElement) {
        if (item && typeof item === 'object') {
          if (typeof item.name === 'string') names.push(item.name);
          if (item.item && typeof item.item === 'object' && typeof item.item.name === 'string') names.push(item.item.name);
        }
      }
    }
    Object.values(node).forEach(walk);
  };
  for (const match of String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(match[1] || ''));
    } catch {
      // Ignore malformed structured data.
    }
  }
  return { names, localities, phones };
}

function servingAreaSentences(text) {
  const areas = [];
  for (const match of String(text || '').matchAll(/serv(?:ing|es)\s+([^.\n]{3,120})/gi)) {
    const chunk = match[1] || '';
    for (const part of chunk.split(/,|\band\b/i)) {
      const value = part.replace(/[^a-zA-Z\s.'-]/g, '').trim();
      if (value && value.length <= 60 && /[a-zA-Z]{3,}/.test(value)) areas.push(value);
    }
  }
  return areas;
}

function stringsFrom(value, max = 30) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()).slice(0, max);
}

/** Merge Firecrawl's extracted JSON with deterministic HTML fallbacks. */
export function factsFromPage(sourceUrl, { json = {}, markdown = '', html = '' } = {}) {
  const text = [markdown, html ? htmlToText(html) : ''].filter(Boolean).join('\n');
  const ld = jsonLdValues(html);
  const headings = [...String(html || '').matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => m[1]);
  const items = [...String(html || '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1]);
  const metaTitle = metaContent(html, ['og:site_name', 'og:title', 'twitter:title']) ||
    stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const metaDescription = metaContent(html, ['og:description', 'twitter:description', 'description']);

  const businessName = (String(json.businessName || '').trim() || metaTitle.split(/[|·—-]/)[0].trim() || new URL(sourceUrl).hostname.replace(/^www\./, ''))
    .slice(0, 120);
  const summary = (String(json.summary || '').trim() || metaDescription).replace(/\s+/g, ' ').trim().slice(0, 600);
  const services = uniqueCapped([...stringsFrom(json.services, 30), ...ld.names, ...headings, ...items], 12, 160);
  const locations = uniqueCapped([...stringsFrom(json.locations, 20), ...ld.localities, ...servingAreaSentences(text)], 10, 160);
  const contactPhone = extractPhone([json.phoneNumber, text].filter(Boolean).join('\n'), html) ||
    (ld.phones[0] || '').slice(0, 32);
  const hours = String(json.hours || '').trim().slice(0, 200) || extractHours(text);

  return { websiteUrl: sourceUrl, businessName, summary, services, locations, contactPhone, hours };
}

async function firecrawlScrape(sourceUrl, apiKey, fetchImpl) {
  const response = await fetchImpl(`${FIRECRAWL_BASE}/scrape`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      url: sourceUrl,
      onlyMainContent: false,
      waitFor: 2000,
      formats: ['json', 'markdown', 'links', 'html'],
      jsonOptions: { prompt: EXTRACT_PROMPT, schema: EXTRACT_SCHEMA },
    }),
    signal: AbortSignal.timeout(25000),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) fail('Website reading is not configured. Try again later.', 503);
    fail('That website could not be read. Check the address and try again.');
  }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
  return {
    json: data.json && typeof data.json === 'object' ? data.json : {},
    markdown: typeof data.markdown === 'string' ? data.markdown : '',
    html: typeof data.html === 'string' ? data.html : typeof data.rawHtml === 'string' ? data.rawHtml : '',
  };
}

async function directFetchHtml(sourceUrl, fetchImpl) {
  const response = await fetchImpl(sourceUrl, {
    headers: { 'user-agent': 'opek-sms-business-enrich/1.0', accept: 'text/html' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) fail('That website could not be read. Check the address and try again.');
  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
    fail('That address did not return a website page.');
  }
  const html = await response.text();
  if (!html || html.length < 200) fail('That website could not be read. Check the address and try again.');
  return html.slice(0, 1500000);
}

/**
 * Fetch business facts for the Business context form.
 * Uses Firecrawl when an API key is provided, otherwise plain HTML parsing.
 */
export async function enrichBusinessFromWebsite(rawUrl, options = {}) {
  const sourceUrl = normalizeWebsiteUrl(rawUrl);
  const fetchImpl = options.fetchImpl || fetch;
  const apiKey = String(options.apiKey || '').trim();
  if (apiKey) {
    const scraped = await firecrawlScrape(sourceUrl, apiKey, fetchImpl).catch((error) => {
      if (error?.status === 503 || error?.status === 400) throw error;
      return null;
    });
    if (scraped) return { ...factsFromPage(sourceUrl, scraped), source: 'firecrawl' };
  }
  const html = await directFetchHtml(sourceUrl, fetchImpl);
  return { ...factsFromPage(sourceUrl, { html }), source: apiKey ? 'firecrawl-fallback' : 'html' };
}
