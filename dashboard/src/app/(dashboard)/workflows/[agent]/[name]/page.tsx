'use client';

/**
 * /workflows/[agent]/[name] — Cron detail + edit page.
 *
 * Renders:
 *  1. CronForm in edit mode (pre-populated from existing cron data)
 *  2. Recent execution history (inline table)
 *  3. Delete button with confirmation dialog
 */

import { useState, useEffect, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  IconArrowLeft,
  IconTrash,
  IconHistory,
  IconClock,
  IconRefresh,
} from '@tabler/icons-react';
import CronForm, { type CronFormValues } from '@/components/workflows/cron-form';
import DeleteCronDialog from '@/components/workflows/delete-cron-dialog';
import { formatRelative } from '@/lib/cron-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CronDefinition {
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  created_at: string;
  last_fired_at?: string;
  fire_count?: number;
  description?: string;
}

interface CronSummaryRow {
  agent: string;
  org: string;
  cron: CronDefinition;
  lastFire: string | null;
  lastStatus: 'fired' | 'retried' | 'failed' | null;
  nextFire: string;
}

interface CronExecutionEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function statusBadgeVariant(
  status: 'fired' | 'retried' | 'failed' | null,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'fired') return 'default';
  if (status === 'failed') return 'destructive';
  if (status === 'retried') return 'secondary';
  return 'outline';
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function CronDetailPage({
  params,
}: {
  params: Promise<{ agent: string; name: string }>;
}) {
  const { agent: rawAgent, name: rawName } = use(params);
  const agent = decodeURIComponent(rawAgent);
  const cronName = decodeURIComponent(rawName);
  const router = useRouter();

  const [cronRow, setCronRow] = useState<CronSummaryRow | null>(null);
  const [executions, setExecutions] = useState<CronExecutionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [execLoading, setExecLoading] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [agents, setAgents] = useState<string[]>([agent]);

  // Fetch cron summary row
  const fetchCron = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/workflows/crons?agent=${encodeURIComponent(agent)}&search=${encodeURIComponent(cronName)}`,
      );
      if (res.ok) {
        const rows: CronSummaryRow[] = await res.json();
        const row = rows.find(r => r.cron.name === cronName && r.agent === agent);
        setCronRow(row ?? null);
      }
    } catch (err) {
      console.error('[cron-detail] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [agent, cronName]);

  // Fetch execution history
  const fetchExecutions = useCallback(async () => {
    setExecLoading(true);
    try {
      const url = `/api/workflows/crons/${encodeURIComponent(agent)}/executions?cronName=${encodeURIComponent(cronName)}&limit=20`;
      const res = await fetch(url);
      if (res.ok) {
        const data: CronExecutionEntry[] = await res.json();
        setExecutions([...data].reverse()); // most recent first
      }
    } catch (err) {
      console.error('[cron-detail] executions fetch failed:', err);
    } finally {
      setExecLoading(false);
    }
  }, [agent, cronName]);

  // Fetch enabled agents list for the form
  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents');
      if (res.ok) {
        const data: { name: string }[] = await res.json();
        setAgents(data.map(a => a.name));
      }
    } catch {
      // ignore — fall back to [agent]
    }
  }, []);

  useEffect(() => {
    fetchCron();
    fetchExecutions();
    fetchAgents();
  }, [fetchCron, fetchExecutions, fetchAgents]);

  const handleEditSuccess = () => {
    fetchCron();
    fetchExecutions();
  };

  const handleDelete = async () => {
    const res = await fetch(
      `/api/workflows/crons/${encodeURIComponent(agent)}/${encodeURIComponent(cronName)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? 'Failed to delete cron.');
    }
    router.push('/workflows');
  };

  // Build form initial values from cron row
  const initialValues: Partial<CronFormValues> | undefined = cronRow
    ? {
        agent: cronRow.agent,
        name: cronRow.cron.name,
        schedule: cronRow.cron.schedule,
        prompt: cronRow.cron.prompt,
        enabled: cronRow.cron.enabled,
        description: cronRow.cron.description ?? '',
      }
    : undefined;

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Back nav */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push('/workflows')}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <IconArrowLeft size={15} />
          Workflows
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium">{agent}</span>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium">{cronName}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <IconClock size={22} className="text-muted-foreground shrink-0" />
            {cronName}
          </h1>
          {cronRow && (
            <p className="text-sm text-muted-foreground mt-1">
              Agent: <span className="font-medium text-foreground">{agent}</span>
              {cronRow.cron.fire_count !== undefined && (
                <> &middot; {cronRow.cron.fire_count} fire{cronRow.cron.fire_count !== 1 ? 's' : ''}</>
              )}
            </p>
          )}
        </div>
        <button
          onClick={() => { fetchCron(); fetchExecutions(); }}
          className="p-2 rounded-md hover:bg-muted transition-colors shrink-0"
          title="Refresh"
        >
          <IconRefresh size={15} className={(loading || execLoading) ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Edit form */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Edit Cron</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-48 animate-pulse rounded-md bg-muted/30" />
          ) : initialValues ? (
            <CronForm
              mode="edit"
              initialValues={initialValues}
              agents={agents}
              onSuccess={handleEditSuccess}
            />
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">
              Cron not found. It may have been deleted.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Execution history */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <IconHistory size={16} />
            Recent Executions
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {execLoading ? (
            <p className="text-sm text-muted-foreground py-4">Loading...</p>
          ) : executions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No executions recorded yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 pr-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">When</th>
                    <th className="pb-2 pr-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                    <th className="pb-2 pr-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Duration</th>
                    <th className="pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.map((entry, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {formatRelative(entry.ts)}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge
                          variant={statusBadgeVariant(entry.status)}
                          className="text-[10px]"
                        >
                          {entry.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {entry.duration_ms}ms
                      </td>
                      <td className="py-2 text-xs text-destructive">
                        {entry.error ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Danger zone — delete */}
      <Card className="border-destructive/30">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-destructive">Delete cron</p>
              <p className="text-xs text-muted-foreground">
                Permanently removes this cron. The scheduler stops immediately.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              disabled={!cronRow}
            >
              <IconTrash size={14} className="mr-1.5" />
              Delete
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Delete confirmation dialog */}
      <DeleteCronDialog
        open={deleteOpen}
        agent={agent}
        cronName={cronName}
        onConfirm={handleDelete}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}
