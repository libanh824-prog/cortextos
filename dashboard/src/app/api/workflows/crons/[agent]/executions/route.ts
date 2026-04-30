/**
 * GET /api/workflows/crons/[agent]/executions
 *
 * Returns recent cron execution log entries for a specific agent.
 * Used by the Workflows dashboard page detail panel (read-only, Subtask 4.1).
 *
 * Query params:
 *   ?cronName=<name>   — filter to a specific cron (optional)
 *   ?limit=<n>         — max entries to return (default: 50, max: 200)
 */

import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { CTX_ROOT } from '@/lib/config';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CronExecutionLogEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// File reader
// ---------------------------------------------------------------------------

const CRONS_DIR = '.cortextOS/state/agents';
const VALID_AGENT = /^[a-z0-9_-]+$/i;

function readExecutionLog(
  agentName: string,
  cronName: string | undefined,
  limit: number,
): CronExecutionLogEntry[] {
  const logPath = path.join(CTX_ROOT, CRONS_DIR, agentName, 'cron-execution.log');
  if (!fs.existsSync(logPath)) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch {
    return [];
  }

  const entries: CronExecutionLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as CronExecutionLogEntry);
    } catch {
      // skip malformed line
    }
  }

  const filtered = cronName
    ? entries.filter(e => e.cron === cronName)
    : entries;

  if (limit > 0 && filtered.length > limit) {
    return filtered.slice(filtered.length - limit);
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agent: string }> },
) {
  const { agent } = await params;
  const decoded = decodeURIComponent(agent);

  if (!VALID_AGENT.test(decoded)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const cronName = searchParams.get('cronName') ?? undefined;
  const limitParam = parseInt(searchParams.get('limit') ?? '50', 10);
  const limit = isNaN(limitParam) || limitParam <= 0 ? 50 : Math.min(limitParam, 200);

  try {
    const entries = readExecutionLog(decoded, cronName, limit);
    return Response.json(entries);
  } catch (err) {
    console.error(`[api/workflows/crons/${decoded}/executions] GET error:`, err);
    return Response.json({ error: 'Failed to read execution log' }, { status: 500 });
  }
}
