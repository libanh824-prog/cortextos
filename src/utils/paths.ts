import { homedir } from 'os';
import { join, resolve } from 'path';
import type { BusPaths } from '../types/index.js';
import { validateInstanceId } from './validate.js';

/**
 * Resolve all bus paths for an agent.
 * Mirrors the path resolution in bash _ctx-env.sh.
 *
 * The directory layout is:
 *   ~/.cortextos/{instance}/
 *     config/                - enabled-agents.json
 *     state/{agent}/         - flat, per-agent subdirs
 *     state/{agent}/heartbeat.json - canonical heartbeat location
 *     state/oauth/           - OAuth accounts.json (token store)
 *     state/usage/           - Usage monitoring snapshots
 *     inbox/{agent}/         - flat (not org-nested)
 *     inflight/{agent}/      - flat
 *     processed/{agent}/     - flat
 *     outbox/{agent}/        - flat
 *     logs/{agent}/          - flat
 *     orgs/{org}/tasks/      - org-scoped
 *     orgs/{org}/approvals/  - org-scoped
 *     orgs/{org}/analytics/  - org-scoped
 */
export function resolvePaths(
  agentName: string,
  instanceId: string = 'default',
  org?: string,
): BusPaths {
  validateInstanceId(instanceId);
  const ctxRoot = join(homedir(), '.cortextos', instanceId);

  // Org-scoped paths for tasks, approvals, analytics
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;

  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agentName),
    inflight: join(ctxRoot, 'inflight', agentName),
    processed: join(ctxRoot, 'processed', agentName),
    logDir: join(ctxRoot, 'logs', agentName),
    stateDir: join(ctxRoot, 'state', agentName),
    taskDir: join(orgBase, 'tasks'),
    approvalDir: join(orgBase, 'approvals'),
    analyticsDir: join(orgBase, 'analytics'),
    deliverablesDir: join(orgBase, 'deliverables'),
  };
}

/**
 * The root directory an instance owns: ~/.cortextos/{instance}.
 *
 * This is the SAME derivation `resolvePaths` uses, and deliberately ignores
 * `process.env.CTX_ROOT` — see the note on `sandboxedRootMismatch` and
 * src/daemon/index.ts (the daemon refuses to inherit a parent cortextOS's
 * CTX_ROOT for its own root).
 */
export function instanceDefaultRoot(instanceId: string = 'default'): string {
  validateInstanceId(instanceId);
  return join(homedir(), '.cortextos', instanceId);
}

/**
 * Detect an environment where CTX_ROOT has been redirected (a test sandbox, or a
 * second install) while the instance id still resolves to another instance's
 * root — the combination in which an IPC call reaches a daemon that owns
 * DIFFERENT state than the caller is reading and writing.
 *
 * Returns a human-readable reason, or null when the environment is consistent.
 *
 * Why this exists: state resolution and socket resolution disagree about
 * CTX_ROOT. `src/bus/crons.ts`, `src/daemon/cron-scheduler.ts` and others honour
 * `process.env.CTX_ROOT`, so a sandboxed run reads and writes tempdir state —
 * but `getIpcPath` derives from the instance id alone, so the same run's IPC
 * still points at ~/.cortextos/{instance}/daemon.sock, i.e. the LIVE fleet
 * daemon. A suite that sandboxed only CTX_ROOT could therefore make the live
 * daemon act on state it cannot see (PR #3 worked around this by sandboxing
 * CTX_INSTANCE_ID as well; this is the structural guard behind that fix).
 *
 * Deliberately NOT fixed by deriving the socket under CTX_ROOT: that would put
 * the daemon's own listen path at the mercy of an inherited env var, which is
 * the exact failure src/daemon/index.ts guards against by always deriving its
 * root from the instance id.
 *
 * In production these agree — the daemon and every agent shell run with
 * CTX_ROOT=~/.cortextos/{instance} — so this returns null and nothing changes.
 */
export function sandboxedRootMismatch(instanceId: string = 'default'): string | null {
  const envRoot = process.env.CTX_ROOT;
  if (!envRoot) return null;
  const strip = (p: string) => resolve(p).replace(/[/\\]+$/, '');
  const expected = strip(instanceDefaultRoot(instanceId));
  const actual = strip(envRoot);
  if (actual === expected) return null;
  return (
    `CTX_ROOT is ${actual} but instance "${instanceId}" owns ${expected} — ` +
    `refusing to use that instance's IPC socket, because this process reads and ` +
    `writes state under CTX_ROOT while the socket belongs to the daemon serving ` +
    `${expected}. Set CTX_INSTANCE_ID to a sandbox instance id, or unset CTX_ROOT.`
  );
}

/**
 * Get the IPC socket path for daemon communication.
 * Unix domain socket on macOS/Linux, named pipe on Windows.
 */
export function getIpcPath(instanceId: string = 'default'): string {
  validateInstanceId(instanceId);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cortextos-${instanceId}`;
  }
  return join(homedir(), '.cortextos', instanceId, 'daemon.sock');
}
