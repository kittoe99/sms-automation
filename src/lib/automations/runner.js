/**
 * Process due automation drips (quote-requests + appointment-reminders).
 */

import { getSupabaseAdmin, isSupabaseConfigured } from '../supabase.js';
import { isOptedOut } from '../messageStore.js';
import { sendSms } from '../twilioClient.js';
import { publish } from '../realtime.js';
import {
  QUOTE_REQUESTS_CATEGORY_ID,
  getQuoteRequestsStep,
  renderTemplate,
} from './quoteRequestsSequence.js';
import {
  advanceAfterSend,
  isDripDue,
  needsQuoteRequestDripSeed,
  seedDripOnEnrollment,
} from './dripState.js';
import {
  APPOINTMENT_REMINDERS_CATEGORY_ID,
  getAppointmentReminderStep,
  renderAppointmentTemplate,
} from './appointmentRemindersSequence.js';
import {
  completeAppointmentAfterSend,
  isAppointmentDripDue,
  needsAppointmentDripSeed,
  seedAppointmentDripOnEnrollment,
} from './appointmentDripState.js';

const BATCH_LIMIT = 50;

/**
 * @returns {Promise<object>}
 */
export async function runAutomationTick({ now = new Date(), limit = BATCH_LIMIT } = {}) {
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

  return {
    quoteRequests: quote,
    appointmentReminders: appointments,
    processed: quote.processed + appointments.processed,
    sent: quote.sent + appointments.sent,
    completed: quote.completed + appointments.completed,
    skipped: quote.skipped + appointments.skipped,
    seeded: quote.seeded + appointments.seeded,
    errors: [...quote.errors, ...appointments.errors],
  };
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
  const { data: rows, error } = await admin
    .from('sms_automation_enrollments')
    .select('*')
    .eq('category_id', categoryId)
    .eq('status', 'enrolled')
    .order('enrolled_at', { ascending: true })
    .limit(Math.min(Math.max(Number(limit) || BATCH_LIMIT, 1), 200));

  if (error) {
    summary.errors.push({ categoryId, error: error.message });
    return summary;
  }

  for (const enrollment of rows || []) {
    try {
      let current = enrollment;

      if (needsSeed(current)) {
        const metadata = seed(current);
        const { data: seeded, error: seedErr } = await admin
          .from('sms_automation_enrollments')
          .update({ metadata, updated_at: new Date().toISOString() })
          .eq('id', current.id)
          .eq('status', 'enrolled')
          .select()
          .maybeSingle();
        if (seedErr) throw seedErr;
        if (!seeded) {
          summary.skipped += 1;
          continue;
        }
        current = seeded;
        summary.seeded += 1;
        publish('enrollment', { event: 'update', record: current });
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

  if (await isOptedOut(enrollment.phone)) {
    await completeAndRemove(enrollment, now, {
      status: 'completed',
      pauseReason: 'opted_out',
    });
    return { completed: true, skipped: true };
  }

  const claimed = await claimEnrollment(enrollment, now, stepIndex);
  if (!claimed) return { skipped: true };

  const body = renderTemplate(step.template, {
    name: enrollment.name,
    phone: enrollment.phone,
  });

  await sendSms({
    to: enrollment.phone,
    body,
    categoryId: QUOTE_REQUESTS_CATEGORY_ID,
    contactName: enrollment.name || null,
    meta: {
      role: 'automation',
      dripSequenceId: drip.sequenceId,
      dripStepId: step.id,
      dripStepIndex: stepIndex,
      enrollmentId: enrollment.id,
    },
  });

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

  if (await isOptedOut(enrollment.phone)) {
    await completeAndRemove(enrollment, now, {
      status: 'completed',
      pauseReason: 'opted_out',
    });
    return { completed: true, skipped: true };
  }

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

  await sendSms({
    to: enrollment.phone,
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

  const advanced = completeAppointmentAfterSend(claimed, now);
  await finishEnrollment(claimed, advanced.metadata, now);
  return { sent: true, completed: true };
}

async function claimEnrollment(enrollment, now, stepIndex) {
  const admin = getSupabaseAdmin();
  const drip = enrollment.metadata?.drip || {};
  const claimUntil = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const claimMeta = {
    ...(enrollment.metadata || {}),
    drip: {
      ...drip,
      nextSendAt: claimUntil,
      claimAt: now.toISOString(),
    },
  };

  const { data: claimed, error: claimErr } = await admin
    .from('sms_automation_enrollments')
    .update({ metadata: claimMeta, updated_at: now.toISOString() })
    .eq('id', enrollment.id)
    .eq('status', 'enrolled')
    .select()
    .maybeSingle();

  if (claimErr) throw claimErr;
  if (!claimed) return null;

  const claimedDrip = claimed.metadata?.drip || {};
  if (Number(claimedDrip.stepIndex || 0) !== stepIndex) return null;
  return claimed;
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

/**
 * Pause active quote-request drips for a phone after inbound reply.
 * Appointment reminders are transactional and are not paused on reply.
 */
export async function pauseQuoteRequestDripsForPhone(phone) {
  if (!isSupabaseConfigured() || !phone) return { paused: 0 };

  const digits = String(phone).replace(/\D/g, '');
  const last10 = digits.slice(-10);
  if (last10.length < 10) return { paused: 0 };

  const admin = getSupabaseAdmin();
  const { data: rows, error } = await admin
    .from('sms_automation_enrollments')
    .select('*')
    .eq('category_id', QUOTE_REQUESTS_CATEGORY_ID)
    .eq('status', 'enrolled')
    .ilike('phone_digits', `%${last10}`);

  if (error) throw error;

  let paused = 0;
  const now = new Date().toISOString();
  for (const row of rows || []) {
    const drip = row.metadata?.drip;
    if (!drip || drip.status !== 'active') continue;
    const metadata = {
      ...(row.metadata || {}),
      drip: {
        ...drip,
        status: 'paused',
        pauseReason: 'inbound_reply',
      },
    };
    const { data, error: updErr } = await admin
      .from('sms_automation_enrollments')
      .update({ metadata, updated_at: now })
      .eq('id', row.id)
      .eq('status', 'enrolled')
      .select()
      .maybeSingle();
    if (updErr) {
      console.warn('[opek-sms] pause drip failed', row.id, updErr.message);
      continue;
    }
    if (data) {
      paused += 1;
      publish('enrollment', { event: 'update', record: data });
    }
  }
  return { paused };
}
