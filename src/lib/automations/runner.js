/**
 * Process due automation drips (quote-requests + appointment-reminders).
 */

import { getSupabaseAdmin, isSupabaseConfigured } from '../supabase.js';
import { isOptedOut } from '../messageStore.js';
import { sendSms } from '../twilioClient.js';
import { publish } from '../realtime.js';
import { toE164 } from '../supabaseContacts.js';
import {
  QUOTE_REQUESTS_CATEGORY_ID,
  getQuoteRequestsStep,
  renderTemplate,
} from './quoteRequestsSequence.js';
import { loadCustomerBookingContext } from '../ai/customerContext.js';
import {
  advanceAfterSend,
  isDripDue,
  needsQuoteRequestDripSeed,
  seedDripOnEnrollment,
} from './dripState.js';
import {
  APPOINTMENT_REMINDERS_CATEGORY_ID,
  computeAppointmentAt,
  getAppointmentReminderStep,
  renderAppointmentTemplate,
} from './appointmentRemindersSequence.js';
import {
  completeAppointmentAfterSend,
  isAppointmentDripDue,
  needsAppointmentDripSeed,
  seedAppointmentDripOnEnrollment,
} from './appointmentDripState.js';
import { drainInboundAiJobs } from '../ai/inboundJobs.js';
import { constrainToSendWindow } from './timeRules.js';
import {
  advanceCustomDrip,
  listAllActiveCustomAutomationGroups,
  seedCustomDrip,
} from './customAutomations.js';
import { getGroupAiSettings } from './groupAiInstructions.js';
import { draftAutomationMessage } from './aiDraft.js';
import { assertTenantDataAccessSafe, findTenant, getCurrentTenant, runWithTenant } from '../tenantContext.js';

const BATCH_LIMIT = 50;

/**
 * @returns {Promise<object>}
 */
export async function runAutomationTick({ now = new Date(), limit = BATCH_LIMIT } = {}) {
  assertTenantDataAccessSafe();
  const retiredCategories = await retireCategoryEnrollments(['contractor-sms'], now);
  const inboundAi = await drainInboundAiJobs({ now, limit: Math.min(Number(limit) || 25, 50) });
  const quote = await runCategoryTick({
    categoryId: QUOTE_REQUESTS_CATEGORY_ID,
    now,
    limit,
    processOne: processDueQuoteEnrollment,
    needsSeed: needsQuoteRequestDripSeed,
    seed: seedDripOnEnrollment,
  });
  const appointments = await runCategoryTick({
    categoryId: APPOINTMENT_REMINDERS_CATEGORY_ID,
    now,
    limit,
    processOne: processDueAppointmentEnrollment,
    needsSeed: needsAppointmentDripSeed,
    seed: seedAppointmentDripOnEnrollment,
  });
  const custom = [];
  let customGroups = [];
  try {
    customGroups = await listAllActiveCustomAutomationGroups();
  } catch (err) {
    custom.push({
      categoryId: 'custom-automation-registry',
      processed: 0,
      sent: 0,
      completed: 0,
      skipped: 0,
      seeded: 0,
      errors: [{ categoryId: null, error: err.message || String(err) }],
    });
  }
  for (const group of customGroups) {
    const tenant = findTenant(group.tenantId);
    if (!tenant) {
      custom.push({
        categoryId: group.id,
        processed: 0,
        sent: 0,
        completed: 0,
        skipped: 0,
        seeded: 0,
        errors: [{ categoryId: group.id, error: `Tenant ${group.tenantId} is not configured` }],
      });
      continue;
    }
    custom.push(
      await runWithTenant(tenant, () =>
        runCategoryTick({
          categoryId: group.id,
          now,
          limit,
          processOne: (enrollment, tickNow) =>
            processDueCustomEnrollment(enrollment, tickNow, group),
          needsSeed: (enrollment) => !enrollment.metadata?.drip?.sequenceId,
          seed: (enrollment) => seedCustomDrip(enrollment, group, now),
        })
      )
    );
  }

  const customTotals = custom.reduce(
    (totals, item) => {
      for (const key of ['processed', 'sent', 'completed', 'skipped', 'seeded']) {
        totals[key] += item[key] || 0;
      }
      totals.errors.push(...(item.errors || []));
      return totals;
    },
    { processed: 0, sent: 0, completed: 0, skipped: 0, seeded: 0, errors: [] }
  );

  return {
    inboundAi,
    retiredCategories,
    quoteRequests: quote,
    appointmentReminders: appointments,
    customAutomations: custom,
    processed: inboundAi.processed + quote.processed + appointments.processed + customTotals.processed,
    sent: quote.sent + appointments.sent + customTotals.sent,
    completed: quote.completed + appointments.completed + customTotals.completed,
    skipped: quote.skipped + appointments.skipped + customTotals.skipped,
    seeded: quote.seeded + appointments.seeded + customTotals.seeded,
    errors: [
      ...retiredCategories.errors,
      ...inboundAi.errors,
      ...quote.errors,
      ...appointments.errors,
      ...customTotals.errors,
    ],
  };
}

async function retireCategoryEnrollments(categoryIds, now) {
  const summary = { removed: 0, errors: [] };
  if (!isSupabaseConfigured()) return summary;
  const admin = getSupabaseAdmin();
  for (const categoryId of categoryIds) {
    try {
      const { data: rows, error } = await admin
        .from('sms_automation_enrollments')
        .select('*')
        .eq('category_id', categoryId)
        .eq('status', 'enrolled')
        .limit(1000);
      if (error) throw error;
      for (const enrollment of rows || []) {
        const metadata = {
          ...(enrollment.metadata || {}),
          removedReason: 'category_retired',
          removedBySource: 'automation_runner',
          drip: {
            ...(enrollment.metadata?.drip || {}),
            status: 'completed',
            nextSendAt: null,
          },
        };
        const { data, error: updateError } = await admin
          .from('sms_automation_enrollments')
          .update({ status: 'removed', metadata, updated_at: now.toISOString() })
          .eq('id', enrollment.id)
          .eq('status', 'enrolled')
          .select()
          .maybeSingle();
        if (updateError) throw updateError;
        if (data) {
          summary.removed += 1;
          publish('enrollment', { event: 'update', record: data });
        }
      }
    } catch (err) {
      summary.errors.push({ categoryId, error: err.message || String(err) });
    }
  }
  return summary;
}

async function runCategoryTick({
  categoryId,
  now,
  limit,
  processOne,
  needsSeed,
  seed,
}) {
  const summary = {
    categoryId,
    processed: 0,
    sent: 0,
    completed: 0,
    skipped: 0,
    seeded: 0,
    errors: [],
  };

  if (!isSupabaseConfigured()) {
    summary.errors.push({ categoryId, error: 'Supabase is not configured' });
    return summary;
  }

  const admin = getSupabaseAdmin();
  const processLimit = Math.min(Math.max(Number(limit) || BATCH_LIMIT, 1), 200);
  // Scan beyond the processing limit so future-dated older rows do not starve
  // newer enrollments that are already due.
  const scanLimit = Math.min(Math.max(processLimit * 8, 200), 1000);
  const { data: rows, error } = await admin
    .from('sms_automation_enrollments')
    .select('*')
    .eq('category_id', categoryId)
    .eq('status', 'enrolled')
    .order('enrolled_at', { ascending: true })
    .limit(scanLimit);

  if (error) {
    summary.errors.push({ categoryId, error: error.message });
    return summary;
  }

  for (const enrollment of rows || []) {
    if (summary.processed >= processLimit) break;
    try {
      let current = enrollment;

      if (needsSeed(current)) {
        const metadata = seed(current);
        let seedQuery = admin
          .from('sms_automation_enrollments')
          .update({ metadata, updated_at: new Date().toISOString() })
          .eq('id', current.id)
          .eq('status', 'enrolled');
        if (current.updated_at) seedQuery = seedQuery.eq('updated_at', current.updated_at);
        const { data: seeded, error: seedErr } = await seedQuery.select().maybeSingle();
        if (seedErr) throw seedErr;
        if (!seeded) {
          summary.skipped += 1;
          continue;
        }
        current = seeded;
        summary.seeded += 1;
        publish('enrollment', { event: 'update', record: current });
      }

      if (
        categoryId === APPOINTMENT_REMINDERS_CATEGORY_ID &&
        !current.metadata?.drip?.nextSendAt
      ) {
        await completeAndRemove(current, now, { completedReason: 'invalid_or_expired_appointment' });
        summary.completed += 1;
        continue;
      }

      const due =
        categoryId === APPOINTMENT_REMINDERS_CATEGORY_ID
          ? isAppointmentDripDue(current, now)
          : isDripDue(current, now);
      if (!due) {
        summary.skipped += 1;
        continue;
      }

      summary.processed += 1;
      const result = await processOne(current, now);
      if (result.sent) summary.sent += 1;
      if (result.completed) summary.completed += 1;
      if (result.skipped) summary.skipped += 1;
    } catch (err) {
      console.error('[opek-sms] drip tick failed', categoryId, enrollment?.id, err);
      summary.errors.push({
        categoryId,
        enrollmentId: enrollment?.id,
        phone: enrollment?.phone,
        error: err.message || String(err),
      });
    }
  }

  return summary;
}

async function processDueQuoteEnrollment(enrollment, now) {
  const drip = enrollment.metadata?.drip || {};
  const stepIndex = Number(drip.stepIndex) || 0;
  const step = getQuoteRequestsStep(stepIndex);
  if (!step) {
    await completeAndRemove(enrollment, now);
    return { completed: true };
  }

  const to = toE164(enrollment.phone);
  if (await isOptedOut(to || enrollment.phone)) {
    await completeAndRemove(enrollment, now, { completedReason: 'sms_opt_out' });
    return { completed: true };
  }

  const allowedAt = constrainToSendWindow(now);
  if (allowedAt && allowedAt.getTime() > now.getTime()) {
    await updateEnrollmentMetadata(
      enrollment.id,
      {
        ...(enrollment.metadata || {}),
        drip: { ...drip, nextSendAt: allowedAt.toISOString() },
      },
      now
    );
    return { skipped: true };
  }

  const previousNextSendAt = drip.nextSendAt || null;
  const claimed = await claimEnrollment(enrollment, now, stepIndex);
  if (!claimed) return { skipped: true };

  const { quotedPrice, serviceType } = await resolveQuoteFields(enrollment);
  const fallbackBody = renderTemplate(step.template, {
    name: enrollment.name,
    phone: enrollment.phone,
    quoted_price: quotedPrice,
    service_type: serviceType,
  });
  const draft = await draftForLegacyRunner(enrollment, {
    id: QUOTE_REQUESTS_CATEGORY_ID,
    name: 'Quote Requests',
    kind: 'quote',
    rule: { aiDraft: true },
  }, fallbackBody);
  const body = draft.body;

  try {
    await sendSms({
      to,
      body,
      categoryId: QUOTE_REQUESTS_CATEGORY_ID,
      contactName: enrollment.name || null,
      meta: {
        role: 'automation',
        dripSequenceId: drip.sequenceId,
        dripStepId: step.id,
        dripStepIndex: stepIndex,
        enrollmentId: enrollment.id,
        quotedPrice: quotedPrice || null,
        aiDrafted: draft.aiDrafted,
      },
    });
  } catch (err) {
    await restoreClaim(claimed, previousNextSendAt, now);
    throw err;
  }

  const advanced = advanceAfterSend(claimed, now);
  if (advanced.completed) {
    await finishEnrollment(claimed, advanced.metadata, now);
    return { sent: true, completed: true };
  }

  await updateEnrollmentMetadata(claimed.id, advanced.metadata, now);
  return { sent: true };
}

async function processDueAppointmentEnrollment(enrollment, now) {
  const drip = enrollment.metadata?.drip || {};
  const step = getAppointmentReminderStep(0);
  if (!step) {
    await completeAndRemove(enrollment, now);
    return { completed: true };
  }

  const to = toE164(enrollment.phone);
  if (await isOptedOut(to || enrollment.phone)) {
    await completeAndRemove(enrollment, now, { completedReason: 'sms_opt_out' });
    return { completed: true };
  }


  const appointment = computeAppointmentAt(
    enrollment.metadata?.appointmentDate,
    enrollment.metadata?.preferredTime
  );
  if (!appointment || appointment.getTime() <= now.getTime()) {
    await completeAndRemove(enrollment, now, { completedReason: 'appointment_expired' });
    return { completed: true };
  }

  const previousNextSendAt = drip.nextSendAt || null;
  const claimed = await claimEnrollment(enrollment, now, 0);
  if (!claimed) return { skipped: true };

  const meta = claimed.metadata || {};
  const body = renderAppointmentTemplate(step.template, {
    name: enrollment.name,
    phone: enrollment.phone,
    service_type: meta.serviceType || 'junk removal or moving',
    appointment_date: meta.appointmentDate,
    preferred_time: meta.preferredTime,
    service_address: meta.serviceAddress,
  });

  try {
    await sendSms({
      to,
      body,
      categoryId: APPOINTMENT_REMINDERS_CATEGORY_ID,
      contactName: enrollment.name || null,
      meta: {
        role: 'automation',
        dripSequenceId: drip.sequenceId || 'appointment-reminders-v1',
        dripStepId: step.id,
        dripStepIndex: 0,
        enrollmentId: enrollment.id,
        bookingId: meta.bookingId || enrollment.record_id || null,
      },
    });
  } catch (err) {
    await restoreClaim(claimed, previousNextSendAt, now);
    throw err;
  }

  const advanced = completeAppointmentAfterSend(claimed, now);
  await finishEnrollment(claimed, advanced.metadata, now);
  return { sent: true, completed: true };
}

async function processDueCustomEnrollment(enrollment, now, group) {
  const drip = enrollment.metadata?.drip || {};
  const stepIndex = Number(drip.stepIndex) || 0;
  if (!group.activeAutomation || stepIndex >= group.rule.repeatCount) {
    await completeAndRemove(enrollment, now, { completedReason: 'sequence_finished' });
    return { completed: true };
  }

  const to = toE164(enrollment.phone);
  if (await isOptedOut(to || enrollment.phone)) {
    await completeAndRemove(enrollment, now, { completedReason: 'sms_opt_out' });
    return { completed: true };
  }

  const allowedAt = constrainToSendWindow(now, {
    startHour: group.rule.startHour,
    endHour: group.rule.endHour,
  });
  if (allowedAt && allowedAt.getTime() > now.getTime()) {
    await updateEnrollmentMetadata(
      enrollment.id,
      {
        ...(enrollment.metadata || {}),
        drip: { ...drip, nextSendAt: allowedAt.toISOString() },
      },
      now
    );
    return { skipped: true };
  }

  const previousNextSendAt = drip.nextSendAt || null;
  const claimed = await claimEnrollment(enrollment, now, stepIndex);
  if (!claimed) return { skipped: true };
  const customStep = group.rule.steps?.[stepIndex];
  if (!customStep) {
    await completeAndRemove(enrollment, now, { completedReason: 'sequence_finished' });
    return { completed: true };
  }
  const fallbackBody = renderTemplate(customStep.template, {
    name: enrollment.name,
    phone: enrollment.phone,
  });
  const draft = await draftForLegacyRunner(enrollment, group, fallbackBody);
  const body = draft.body;

  try {
    await sendSms({
      to,
      body,
      categoryId: group.id,
      contactName: enrollment.name || null,
      meta: {
        role: 'automation',
        customAutomation: true,
        dripSequenceId: group.id,
        dripStepId: customStep.id || `send-${stepIndex + 1}`,
        dripStepIndex: stepIndex,
        enrollmentId: enrollment.id,
        aiDrafted: draft.aiDrafted,
      },
    });
  } catch (err) {
    await restoreClaim(claimed, previousNextSendAt, now);
    throw err;
  }

  const advanced = advanceCustomDrip(claimed, group, now);
  if (advanced.completed) {
    await finishEnrollment(claimed, advanced.metadata, now);
    return { sent: true, completed: true };
  }
  await updateEnrollmentMetadata(claimed.id, advanced.metadata, now);
  return { sent: true };
}

async function draftForLegacyRunner(enrollment, group, fallbackBody) {
  let settings = null;
  try {
    settings = await getGroupAiSettings(group.id);
  } catch {
    // Drafting is best-effort; the saved template remains deliverable.
  }
  const tenant = getCurrentTenant();
  return draftAutomationMessage(
    {
      enrollment,
      group,
      settings,
      business: { name: tenant.name, timeZone: tenant.timeZone },
      contact: { name: enrollment.name, phone: enrollment.phone },
      history: [],
    },
    fallbackBody
  );
}

async function resolveQuoteFields(enrollment) {
  const meta = enrollment?.metadata || {};
  let serviceType =
    meta.serviceType ||
    meta.service_type ||
    meta.drip?.serviceType ||
    null;
  let quotedPrice =
    meta.quotedPrice ||
    meta.quoted_price ||
    meta.quoted_price_summary ||
    meta.drip?.quotedPrice ||
    null;

  const needsCtx =
    !(quotedPrice != null && String(quotedPrice).trim()) ||
    !(serviceType != null && String(serviceType).trim());

  if (needsCtx) {
    try {
      const ctx = await loadCustomerBookingContext(enrollment.phone);
      if (!(serviceType != null && String(serviceType).trim())) {
        serviceType = ctx?.proposed?.service_type || null;
      }
      if (!(quotedPrice != null && String(quotedPrice).trim())) {
        const summary = ctx?.proposed?.quoted_price_summary || null;
        if (summary) quotedPrice = summary;
        else {
          const bd = ctx?.prebookings?.[0]?.booking_details;
          // For moving, never fall back to a numeric job total.
          const st = serviceType || bd?.service_type || null;
          const isMoving = /\b(moving|movers?|local\s*move)\b/i.test(String(st || ''));
          if (!isMoving && bd?.price != null) quotedPrice = bd.price;
        }
      }
    } catch (err) {
      console.warn('[opek-sms] quote price lookup failed', err.message || err);
    }
  }

  return {
    quotedPrice: quotedPrice != null && String(quotedPrice).trim() ? quotedPrice : null,
    serviceType: serviceType != null && String(serviceType).trim() ? serviceType : null,
  };
}

async function claimEnrollment(enrollment, now, stepIndex) {
  const admin = getSupabaseAdmin();
  const drip = enrollment.metadata?.drip || {};
  const claimUntil = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const claimMeta = {
    ...(enrollment.metadata || {}),
    drip: {
      ...drip,
      status: 'active',
      pauseReason: null,
      nextSendAt: claimUntil,
      claimAt: now.toISOString(),
    },
  };

  let claimQuery = admin
    .from('sms_automation_enrollments')
    .update({ metadata: claimMeta, updated_at: now.toISOString() })
    .eq('id', enrollment.id)
    .eq('status', 'enrolled')
    .contains('metadata', {
      drip: {
        stepIndex: drip.stepIndex ?? 0,
        nextSendAt: drip.nextSendAt ?? null,
      },
    });
  if (enrollment.updated_at) {
    claimQuery = claimQuery.eq('updated_at', enrollment.updated_at);
  }
  const { data: claimed, error: claimErr } = await claimQuery.select().maybeSingle();

  if (claimErr) throw claimErr;
  if (!claimed) return null;

  const claimedDrip = claimed.metadata?.drip || {};
  if (Number(claimedDrip.stepIndex || 0) !== stepIndex) return null;
  return claimed;
}

/** Undo claim lock so a failed send can retry on the next tick. */
async function restoreClaim(enrollment, previousNextSendAt, now) {
  const drip = enrollment?.metadata?.drip || {};
  const { claimAt: _claimAt, ...rest } = drip;
  const metadata = {
    ...(enrollment.metadata || {}),
    drip: {
      ...rest,
      nextSendAt: previousNextSendAt,
    },
  };
  await updateEnrollmentMetadata(enrollment.id, metadata, now);
}

async function updateEnrollmentMetadata(id, metadata, now) {
  const admin = getSupabaseAdmin();
  const { data: updated, error: updErr } = await admin
    .from('sms_automation_enrollments')
    .update({
      metadata,
      updated_at: now.toISOString(),
    })
    .eq('id', id)
    .eq('status', 'enrolled')
    .select()
    .maybeSingle();
  if (updErr) throw updErr;
  if (updated) publish('enrollment', { event: 'update', record: updated });
}

async function finishEnrollment(enrollment, metadata, now) {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('sms_automation_enrollments')
    .update({
      status: 'removed',
      metadata,
      updated_at: now.toISOString(),
    })
    .eq('id', enrollment.id)
    .eq('status', 'enrolled')
    .select()
    .maybeSingle();
  if (error) throw error;
  if (data) publish('enrollment', { event: 'update', record: data });
}

async function completeAndRemove(enrollment, now, dripPatch = {}) {
  const metadata = {
    ...(enrollment.metadata || {}),
    drip: {
      ...(enrollment.metadata?.drip || {}),
      status: 'completed',
      nextSendAt: null,
      ...dripPatch,
    },
  };
  await finishEnrollment(enrollment, metadata, now);
}
