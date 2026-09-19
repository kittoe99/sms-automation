import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, call } from './helpers/database.js';

async function seedBusiness(db, tenant = 'bello') {
  await db.query(`insert into public.sms_businesses(tenant_id,name) values('${tenant}','Bello Moving') on conflict do nothing`);
}

test('business onboarding rejects incomplete context with Get Started step-1 rules', async () => {
  const db = await testDatabase();
  await seedBusiness(db);
  await assert.rejects(call(db, 'save_business_profile', 'admin', 'bello', {}), /Business name is required/);
  await assert.rejects(
    call(db, 'save_business_profile', 'admin', 'bello', { businessName: 'Bello', websiteUrl: 'http://plain.com', services: ['Moving'], locations: ['Denver'] }),
    /https:\/\//
  );
  await assert.rejects(
    call(db, 'save_business_profile', 'admin', 'bello', { businessName: 'Bello', services: [], locations: ['Denver'] }),
    /1-30 services/
  );
  await assert.rejects(
    call(db, 'save_business_profile', 'admin', 'bello', { businessName: 'Bello', services: ['Moving'], locations: [] }),
    /1-20 service areas/
  );
  await assert.rejects(
    call(db, 'save_business_profile', 'admin', 'bello', { businessName: 'Bello', services: ['x'.repeat(161)], locations: ['Denver'] }),
    /1-30 services/
  );
  await assert.rejects(
    call(db, 'save_business_profile', 'admin', 'bello', { businessName: 'Bello', summary: 'Too short', services: ['Moving'], locations: ['Denver'] }),
    /Summary must be 20-2000/
  );
  await assert.rejects(
    call(db, 'save_business_profile', 'admin', 'bello', { businessName: 'Bello', tone: 'robotic', services: ['Moving'], locations: ['Denver'] }),
    /brand voice/
  );
  await assert.rejects(
    call(db, 'save_business_profile', 'admin', 'bello', { businessName: 'Bello', services: ['Moving'], locations: ['Denver'], faqs: ['x'.repeat(301)] }),
    /20 FAQs/
  );
  await db.close();
});

test('business onboarding saves trimmed context and reports completion', async () => {
  const db = await testDatabase();
  await seedBusiness(db);
  const before = await call(db, 'business_profile', 'admin', 'bello');
  assert.equal(before.onboardingComplete, false);
  const saved = await call(db, 'save_business_profile', 'admin', 'bello', {
    businessName: '  Bello Moving  ',
    websiteUrl: 'https://example.com',
    summary: '  Full-service moving and junk removal across Denver.  ',
    services: ['  Junk removal  ', 'Moving help'],
    locations: ['Denver'],
    hours: 'Mon–Fri 8am–6pm',
    contactPhone: '+17205551234',
    tone: 'friendly',
    faqs: ['  Estimates are free.  '],
    handoff: 'Hand off angry customers.',
  });
  assert.equal(saved.onboardingComplete, true);
  assert.equal(saved.onboarding.businessName, 'Bello Moving');
  assert.deepEqual(saved.onboarding.services, ['Junk removal', 'Moving help']);
  assert.deepEqual(saved.onboarding.locations, ['Denver']);
  assert.equal(saved.onboarding.summary, 'Full-service moving and junk removal across Denver.');
  assert.equal(saved.onboarding.hours, 'Mon–Fri 8am–6pm');
  assert.equal(saved.onboarding.contactPhone, '+17205551234');
  assert.equal(saved.onboarding.tone, 'friendly');
  assert.deepEqual(saved.onboarding.faqs, ['Estimates are free.']);
  assert.equal(saved.onboarding.handoff, 'Hand off angry customers.');
  assert.ok(saved.onboarding.completedAt);
  const after = await call(db, 'business_profile', 'admin', 'bello');
  assert.equal(after.onboardingComplete, true);
  await assert.rejects(call(db, 'business_profile', 'admin', 'unknown'), /Unknown business/);
  await db.close();
});
