/**
 * cron-utils.ts — Pure cron/schedule helpers for the Next.js dashboard.
 *
 * These are intentionally duplicated from src/bus/cron-state.ts so that
 * the dashboard (a Next.js app) does not need to import daemon-side Node.js
 * modules at runtime.  Any changes to the core parsing logic should be
 * reflected here as well.
 */

/**
 * Parse an interval string like "6h", "30m", "1d", "2w" into milliseconds.
 * Returns NaN for unrecognised formats (e.g. cron expressions like "0 8 * * *").
 */
export function parseDurationMs(interval: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(interval.trim());
  if (!match) return NaN;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * multipliers[unit];
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * e.g. 3600000 => "1h", 86400000 => "1d"
 */
export function formatDuration(ms: number): string {
  if (ms >= 604_800_000 && ms % 604_800_000 === 0) return `${ms / 604_800_000}w`;
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

/**
 * Format a schedule string (interval shorthand or cron expression) as a
 * human-readable label for display in the dashboard.
 *
 * e.g. "6h"         => "every 6 hours"
 *      "30m"        => "every 30 minutes"
 *      "0 9 * * *"  => "0 9 * * *"  (returned as-is — cron exprs are opaque)
 */
export function formatSchedule(schedule: string): string {
  const ms = parseDurationMs(schedule);
  if (!isNaN(ms)) {
    const weeks   = ms / 604_800_000;
    const days    = ms / 86_400_000;
    const hours   = ms / 3_600_000;
    const minutes = ms / 60_000;

    if (ms >= 604_800_000 && ms % 604_800_000 === 0)
      return `every ${weeks} week${weeks !== 1 ? 's' : ''}`;
    if (ms >= 86_400_000 && ms % 86_400_000 === 0)
      return `every ${days} day${days !== 1 ? 's' : ''}`;
    if (ms >= 3_600_000 && ms % 3_600_000 === 0)
      return `every ${hours} hour${hours !== 1 ? 's' : ''}`;
    return `every ${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }
  // Cron expression — return as-is
  return schedule;
}

/**
 * Format a timestamp as a relative string ("2 hours ago", "in 5 minutes").
 * Falls back to the ISO string if the input is null/undefined/unparseable.
 */
export function formatRelative(isoTs: string | null | undefined): string {
  if (!isoTs || isoTs === 'unknown') return isoTs ?? 'never';
  const now = Date.now();
  const ts = new Date(isoTs).getTime();
  if (isNaN(ts)) return isoTs;

  const diffMs = ts - now;
  const absDiff = Math.abs(diffMs);
  const past = diffMs < 0;

  let label: string;
  if (absDiff < 60_000) {
    label = 'just now';
    return label;
  } else if (absDiff < 3_600_000) {
    const mins = Math.round(absDiff / 60_000);
    label = `${mins} min${mins !== 1 ? 's' : ''}`;
  } else if (absDiff < 86_400_000) {
    const hrs = Math.round(absDiff / 3_600_000);
    label = `${hrs} hr${hrs !== 1 ? 's' : ''}`;
  } else {
    const days = Math.round(absDiff / 86_400_000);
    label = `${days} day${days !== 1 ? 's' : ''}`;
  }

  return past ? `${label} ago` : `in ${label}`;
}
