import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichBusinessFromWebsite, factsFromPage, normalizeWebsiteUrl } from '../src/lib/websiteEnrich.js';

test('website URL normalization rejects non-public hosts', () => {
  assert.equal(normalizeWebsiteUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeWebsiteUrl('http://example.com/page'), 'https://example.com/page');
  assert.throws(() => normalizeWebsiteUrl(''), /website address/);
  assert.throws(() => normalizeWebsiteUrl('not a url'), /valid website/);
  assert.throws(() => normalizeWebsiteUrl('http://localhost:3000/'), /valid website/);
  assert.throws(() => normalizeWebsiteUrl('http://192.168.1.10/'), /valid website/);
});

test('facts fall back to headings, lists, tel links and hours without Firecrawl', async () => {
  const html = `<!DOCTYPE html><html><head><title>Bello Moving | Denver Movers</title>
    <meta name="description" content="Full-service moving and junk removal across Denver.">
    <script type="application/ld+json">{"@type":"LocalBusiness","name":"Bello Moving","telephone":"+17205551234","address":{"@type":"PostalAddress","addressLocality":"Denver","addressRegion":"CO"}}</script>
    </head><body>
    <h1>Junk Removal</h1><h2>Moving Help</h2>
    <ul><li>Labor-only loading</li><li>Home</li></ul>
    <a href="tel:+17205551234">Call us</a>
    <p>Hours: Mon-Fri 8am-6pm, Sat 9am-2pm</p>
    <p>Proudly serving Denver, Aurora and Lakewood.</p>
    </body></html>`;
  const fetchImpl = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  const facts = await enrichBusinessFromWebsite('https://example.com', { fetchImpl });
  assert.equal(facts.source, 'html');
  assert.match(facts.businessName, /Bello Moving/);
  assert.match(facts.summary, /junk removal/i);
  assert.ok(facts.services.includes('Junk Removal'));
  assert.ok(facts.services.includes('Moving Help'));
  assert.ok(!facts.services.includes('Home'));
  assert.ok(facts.locations.includes('Denver'));
  assert.equal(facts.contactPhone, '+17205551234');
  assert.match(facts.hours, /Mon-Fri 8am-6pm/);
});

test('Firecrawl extraction wins and junk nav labels are dropped', async () => {
  const payload = {
    data: {
      json: {
        businessName: 'Bello Moving',
        summary: 'Movers in Denver.',
        services: ['Junk removal', 'Home', 'Moving help'],
        locations: ['Denver'],
        phoneNumber: '+17205551234',
        hours: 'Mon-Fri 8am-6pm',
      },
      markdown: '# Bello Moving\nWe move homes.',
      html: '<html><body><a href="tel:+17205559999">old</a></body></html>',
    },
  };
  const fetchImpl = async () => Response.json(payload);
  const facts = await enrichBusinessFromWebsite('example.com', { apiKey: 'fc-test', fetchImpl });
  assert.equal(facts.source, 'firecrawl');
  assert.equal(facts.businessName, 'Bello Moving');
  assert.ok(facts.services.includes('Junk removal'));
  assert.ok(!facts.services.includes('Home'));
  assert.equal(facts.contactPhone, '+17205559999');
});

test('factsFromPage caps lists to the save limits', () => {
  const facts = factsFromPage('https://example.com/', {
    json: {
      services: Array.from({ length: 40 }, (_, i) => `Service ${i}`),
      locations: Array.from({ length: 30 }, (_, i) => `City ${i}`),
    },
  });
  assert.ok(facts.services.length <= 12);
  assert.ok(facts.locations.length <= 10);
});

test('Firecrawl auth failure surfaces a configuration error', async () => {
  const fetchImpl = async () => new Response('{}', { status: 401 });
  await assert.rejects(
    enrichBusinessFromWebsite('https://example.com', { apiKey: 'bad', fetchImpl }),
    /not configured/
  );
});
