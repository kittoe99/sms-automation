import { getCurrentTenant } from '../tenantContext.js';

export const DEFAULT_BUSINESS_TIME_ZONE = 'America/Denver';

export function getBusinessTimeZone() {
  return getCurrentTenant()?.timeZone || process.env.BUSINESS_TIME_ZONE || DEFAULT_BUSINESS_TIME_ZONE;
}

/** Convert business-local calendar parts to a UTC Date. */
export function zonedDateTimeToUtc(parts, timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  try {
    const desired = Date.UTC(parts.y, parts.m - 1, parts.d, parts.hour, parts.minute, 0);
    let candidate = desired;
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });

    for (let i = 0; i < 3; i += 1) {
      const observed = Object.fromEntries(
        formatter
          .formatToParts(new Date(candidate))
          .filter((part) => part.type !== 'literal')
          .map((part) => [part.type, Number(part.value)])
      );
      const observedUtc = Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        observed.second
      );
      const correction = desired - observedUtc;
      candidate += correction;
      if (correction === 0) break;
    }

    return new Date(candidate);
  } catch {
    return null;
  }
}

export function getZonedParts(value, timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)])
    );
  } catch {
    return null;
  }
}

/** Keep marketing sends inside the configured local-time window. */
export function constrainToSendWindow(
  value,
  {
    timeZone = getBusinessTimeZone(),
    startHour = 9,
    endHour = 19,
  } = {}
) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const local = getZonedParts(date, timeZone);
  if (!local) return null;
  if (local.hour >= startHour && local.hour < endHour) return date;

  let target = { y: local.year, m: local.month, d: local.day, hour: startHour, minute: 0 };
  if (local.hour >= endHour) {
    const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    target = {
      y: nextDay.getUTCFullYear(),
      m: nextDay.getUTCMonth() + 1,
      d: nextDay.getUTCDate(),
      hour: startHour,
      minute: 0,
    };
  }
  return zonedDateTimeToUtc(target, timeZone);
}
