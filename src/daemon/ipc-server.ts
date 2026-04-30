import { createServer, Server, Socket } from 'net';
import { existsSync, unlinkSync, chmodSync, readFileSync } from 'fs';
import { join, resolve as pathResolve } from 'path';
import type { IPCRequest, IPCResponse, CronSummaryRow } from '../types/index.js';
import { AgentManager } from './agent-manager.js';
import { getIpcPath } from '../utils/paths.js';
import { readCrons, getExecutionLog } from '../bus/crons.js';
import { nextFireFromCron } from './cron-scheduler.js';
import { parseDurationMs } from '../bus/cron-state.js';

const WORKER_NAME_REGEX = /^[a-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// list-all-crons helper — Subtask 4.1
// ---------------------------------------------------------------------------

/**
 * Compute the next fire timestamp (ISO string) for a cron definition.
 * Reuses the same parser logic as CronScheduler (nextFireFromCron + parseDurationMs)
 * without duplicating the parser.
 *
 * @param schedule    - Interval shorthand or 5-field cron expression.
 * @param lastFiredAt - ISO 8601 of last fire; if absent uses `now`.
 * @param now         - Epoch ms for "now" (injectable for testing).
 */
export function computeNextFire(
  schedule: string,
  lastFiredAt: string | undefined,
  now = Date.now(),
): string {
  const referenceMs = lastFiredAt ? new Date(lastFiredAt).getTime() : now;

  const durationMs = parseDurationMs(schedule);
  if (!isNaN(durationMs)) {
    const next = referenceMs + durationMs;
    // If next is still in the past (daemon was stopped for a long time), advance to now
    return new Date(next <= now ? now + durationMs : next).toISOString();
  }

  // Try as a 5-field cron expression
  const nextMs = nextFireFromCron(schedule, now);
  if (!isNaN(nextMs)) {
    return new Date(nextMs).toISOString();
  }

  // Unparseable schedule — return a sentinel so callers can detect it
  return 'unknown';
}

/**
 * Walk all enabled agents from enabled-agents.json, read each agent's crons.json
 * and cron execution log, and return a combined summary array.
 */
function listAllCrons(): CronSummaryRow[] {
  const ctxRoot = process.env.CTX_ROOT ?? process.cwd();
  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');

  let enabledAgents: Record<string, { enabled?: boolean; org?: string }> = {};
  if (existsSync(enabledFile)) {
    try {
      enabledAgents = JSON.parse(readFileSync(enabledFile, 'utf-8'));
    } catch {
      // corrupt — fall through with empty map
    }
  }

  const rows: CronSummaryRow[] = [];
  const now = Date.now();

  for (const [agentName, entry] of Object.entries(enabledAgents)) {
    if (entry.enabled === false) continue;

    const org = entry.org ?? '';
    const crons = readCrons(agentName);

    for (const cron of crons) {
      // Read the last execution log entry for this cron
      const logEntries = getExecutionLog(agentName, cron.name, 1);
      const lastEntry = logEntries.length > 0 ? logEntries[logEntries.length - 1] : null;

      rows.push({
        agent: agentName,
        org,
        cron,
        lastFire: lastEntry?.ts ?? null,
        lastStatus: lastEntry?.status ?? null,
        nextFire: computeNextFire(cron.schedule, cron.last_fired_at, now),
      });
    }
  }

  return rows;
}

/**
 * IPC server for CLI <-> daemon communication.
 * Uses Unix domain socket on macOS/Linux, named pipe on Windows.
 * Replaces SIGUSR1 and other signal-based IPC.
 */
export class IPCServer {
  private server: Server | null = null;
  private socketPath: string;
  private agentManager: AgentManager;

  constructor(agentManager: AgentManager, instanceId: string = 'default') {
    this.agentManager = agentManager;
    this.socketPath = getIpcPath(instanceId);
  }

  /**
   * Start listening for IPC connections.
   */
  async start(): Promise<void> {
    // Clean up stale socket
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => {
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk.toString();
          // Try to parse complete JSON messages
          try {
            const request: IPCRequest = JSON.parse(data);
            data = '';
            this.handleRequest(request, socket);
          } catch {
            // Incomplete JSON, wait for more data
          }
        });

        socket.on('error', () => {
          // Client disconnected
        });
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Race: process was killed after unlink but before bind completed.
          // Clean up the re-created socket and retry once.
          try { unlinkSync(this.socketPath); } catch { /* ignore */ }
          this.server!.listen(this.socketPath, () => {
            console.log(`[ipc] Listening on ${this.socketPath} (recovered from stale socket)`);
            resolve();
          });
        } else {
          reject(err);
        }
      });

      this.server.listen(this.socketPath, () => {
        if (process.platform !== 'win32') {
          try {
            chmodSync(this.socketPath, 0o600);
          } catch {
            /* Windows / no-op */
          }
        }
        console.log(`[ipc] Listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  /**
   * Stop the IPC server.
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Clean up socket file
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Handle an incoming IPC request.
   */
  private handleRequest(request: IPCRequest, socket: Socket): void {
    // BUG-015: log every incoming IPC request with its source so we can
    // trace which CLI command triggered which daemon action. The source
    // field is populated by CLI clients (cortextos enable / disable / stop
    // / bus / etc.); older or untracked callers fall back to 'unknown'.
    const agentTag = request.agent ? ` ${request.agent}` : '';
    console.log(`[ipc] ${request.type}${agentTag} from ${request.source || 'unknown'}`);

    let response: IPCResponse;

    try {
      switch (request.type) {
        case 'status':
          response = {
            success: true,
            data: this.agentManager.getAllStatuses(),
          };
          break;

        case 'list-agents':
          response = {
            success: true,
            data: this.agentManager.getAgentNames(),
          };
          break;

        case 'start-agent':
          if (!request.agent) {
            response = { success: false, error: 'Agent name required' };
          } else {
            // Start is async, respond immediately
            this.agentManager.startAgent(
              request.agent,
              (request.data?.dir as string) || '',
            ).catch(err => console.error(`Failed to start ${request.agent}:`, err));
            response = { success: true, data: `Starting ${request.agent}` };
          }
          break;

        case 'stop-agent':
          if (!request.agent) {
            response = { success: false, error: 'Agent name required' };
          } else {
            this.agentManager.stopAgent(request.agent)
              .catch(err => console.error(`Failed to stop ${request.agent}:`, err));
            response = { success: true, data: `Stopping ${request.agent}` };
          }
          break;

        case 'restart-agent':
          if (!request.agent) {
            response = { success: false, error: 'Agent name required' };
          } else {
            this.agentManager.restartAgent(request.agent)
              .catch(err => console.error(`Failed to restart ${request.agent}:`, err));
            response = { success: true, data: `Restarting ${request.agent}` };
          }
          break;

        case 'wake':
          // Wake a specific agent's fast checker (replaces SIGUSR1)
          if (request.agent) {
            const checker = this.agentManager.getFastChecker(request.agent);
            if (checker) {
              checker.wake();
              response = { success: true, data: 'Woke fast checker' };
            } else {
              response = { success: false, error: `Agent ${request.agent} not found` };
            }
          } else {
            response = { success: false, error: 'Agent name required' };
          }
          break;

        case 'spawn-worker': {
          const d = request.data as { name?: string; dir?: string; prompt?: string; parent?: string; model?: string } | undefined;
          if (!d?.name || !d?.dir || !d?.prompt) {
            response = { success: false, error: 'spawn-worker requires: name, dir, prompt' };
          } else if (!WORKER_NAME_REGEX.test(d.name) || d.name.length > 64) {
            response = { success: false, error: 'Invalid worker name' };
          } else {
            const resolvedDir = pathResolve(d.dir);
            const ctxRoot = process.env.CTX_ROOT ? pathResolve(process.env.CTX_ROOT) : '';
            const cwd = pathResolve(process.cwd());
            const underCtxRoot = ctxRoot && (resolvedDir === ctxRoot || resolvedDir.startsWith(ctxRoot + '/'));
            const underCwd = resolvedDir === cwd || resolvedDir.startsWith(cwd + '/');
            if (!underCtxRoot && !underCwd) {
              response = { success: false, error: 'Invalid worker dir' };
            } else {
              this.agentManager.spawnWorker(d.name, resolvedDir, d.prompt, d.parent, d.model)
                .catch(err => console.error(`[ipc] spawn-worker failed:`, err));
              response = { success: true, data: `Spawning worker ${d.name}` };
            }
          }
          break;
        }

        case 'terminate-worker': {
          const workerName = request.data?.name as string | undefined;
          if (!workerName) {
            response = { success: false, error: 'terminate-worker requires: name' };
          } else {
            this.agentManager.terminateWorker(workerName)
              .catch(err => console.error(`[ipc] terminate-worker failed:`, err));
            response = { success: true, data: `Terminating worker ${workerName}` };
          }
          break;
        }

        case 'list-workers':
          response = { success: true, data: this.agentManager.listWorkers() };
          break;

        case 'inject-worker': {
          const injectName = request.data?.name as string | undefined;
          const injectText = request.data?.text as string | undefined;
          if (!injectName || !injectText) {
            response = { success: false, error: 'inject-worker requires: name, text' };
          } else {
            const ok = this.agentManager.injectWorker(injectName, injectText);
            response = ok
              ? { success: true, data: `Injected into worker ${injectName}` }
              : { success: false, error: `Worker ${injectName} not found or not running` };
          }
          break;
        }

        case 'inject-agent': {
          const agentToInject = request.agent;
          const textToInject = request.data?.text as string | undefined;
          if (!agentToInject || !textToInject) {
            response = { success: false, error: 'inject-agent requires: agent, data.text' };
          } else {
            const ok = this.agentManager.injectAgent(agentToInject, textToInject);
            response = ok
              ? { success: true, data: `Injected into agent ${agentToInject}` }
              : { success: false, error: `Agent ${agentToInject} not found or not running` };
          }
          break;
        }

        case 'reload-crons': {
          const agentToReload = request.agent;
          if (!agentToReload) {
            response = { success: false, error: 'reload-crons requires agent name' };
          } else {
            // crons.json was already written atomically by the CLI — acknowledge the reload.
            // CronScheduler picks up the change on its next 30s tick.
            this.agentManager.reloadCrons(agentToReload);
            response = { success: true, data: `Crons reloaded for ${agentToReload}` };
          }
          break;
        }

        case 'fire-cron': {
          const agentToFire = request.agent;
          const cronName = request.data?.name as string | undefined;
          const cronPrompt = request.data?.prompt as string | undefined;
          if (!agentToFire || !cronName || !cronPrompt) {
            response = { success: false, error: 'fire-cron requires: agent, data.name, data.prompt' };
          } else {
            const injection = `[CRON: ${cronName}] ${cronPrompt}`;
            const ok = this.agentManager.injectAgent(agentToFire, injection);
            response = ok
              ? { success: true, data: `Fired cron '${cronName}' for ${agentToFire}` }
              : { success: false, error: `Agent ${agentToFire} not found or not running` };
          }
          break;
        }

        case 'list-all-crons': {
          response = {
            success: true,
            data: listAllCrons(),
          };
          break;
        }

        case 'list-cron-executions': {
          const execAgent = request.agent;
          const execCronName = request.data?.cronName as string | undefined;
          const execLimit = typeof request.data?.limit === 'number' ? request.data.limit : 50;
          if (!execAgent) {
            response = { success: false, error: 'list-cron-executions requires agent name' };
          } else {
            const entries = getExecutionLog(execAgent, execCronName, execLimit);
            response = { success: true, data: entries };
          }
          break;
        }

        default:
          response = { success: false, error: `Unknown command: ${request.type}` };
      }
    } catch (err) {
      response = { success: false, error: String(err) };
    }

    try {
      socket.write(JSON.stringify(response));
      socket.end();
    } catch {
      // Client disconnected
    }
  }
}

/**
 * IPC client for sending commands to the daemon.
 * Used by CLI commands.
 */
export class IPCClient {
  private socketPath: string;

  constructor(instanceId: string = 'default') {
    this.socketPath = getIpcPath(instanceId);
  }

  /**
   * Send a command to the daemon and get the response.
   */
  async send(request: IPCRequest): Promise<IPCResponse> {
    const { createConnection } = require('net');

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath, () => {
        socket.write(JSON.stringify(request));
      });

      let data = '';
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      socket.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid response from daemon'));
        }
      });

      socket.on('error', (err: Error) => {
        if ((err as any).code === 'ECONNREFUSED' || (err as any).code === 'ENOENT') {
          resolve({
            success: false,
            error: 'Daemon is not running. Start it with: cortextos start',
          });
        } else {
          reject(err);
        }
      });

      // Timeout after 5 seconds
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('IPC request timed out'));
      });
    });
  }

  /**
   * Check if the daemon is running.
   */
  async isDaemonRunning(): Promise<boolean> {
    try {
      const response = await this.send({ type: 'status' });
      return response.success;
    } catch {
      return false;
    }
  }
}
