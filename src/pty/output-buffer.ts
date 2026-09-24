import { appendFileSync, renameSync, statSync } from 'fs';
import { redactSecrets } from './redact.js';

// Dynamic import for strip-ansi (ESM module)
let stripAnsi: (text: string) => string;
async function loadStripAnsi() {
  if (!stripAnsi) {
    const mod = await import('strip-ansi');
    stripAnsi = mod.default;
  }
  return stripAnsi;
}

const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB — rotate before OS file-cache pressure builds

/**
 * STRICT discrimination of the Claude Code "Bypass Permissions" first-run screen,
 * for use as a false-positive guard on `isBootstrapped()`.
 *
 * Deliberately stricter than `AgentPTY.detectFirstRunPrompt`, which drives the
 * auto-accept keystroke, because THE TWO CONSUMERS FAIL IN OPPOSITE DIRECTIONS
 * over the same text and so must not share a threshold:
 *
 *   - auto-accept ("should I press Down+Enter?") — a false NEGATIVE wedges first
 *     boot, a false positive is harmless (the write is bootstrap-gated, fires once,
 *     and stops the poll). Permissive is correct there.
 *   - this guard ("is the agent NOT up yet?") — a false POSITIVE suppresses
 *     bootstrap for a RUNNING agent, which stops message injection entirely.
 *     Strict is correct here.
 *
 * Hence three CO-OCCURRING tokens including the screen's numbered default option,
 * not the two that are enough to justify a keystroke. Live agent output discusses
 * these screens by name — this file's own history does — so "bypass" plus "accept"
 * is reachable in ordinary conversation text; "1. No, exit" alongside both is not.
 *
 * Case-insensitive on purpose: the point is the CONJUNCTION, not the casing. Today's
 * screen renders title-case "Permissions", so `isBootstrapped` never matches it and
 * this guard is inert; it exists so a future TUI that renders lowercase cannot turn
 * the status-bar match into a silent wedge.
 *
 * @param cleaned ANSI-stripped recent output.
 */
export function isShowingBypassScreen(cleaned: string): boolean {
  return (
    /bypass/i.test(cleaned) &&
    /accept/i.test(cleaned) &&
    /no,\s*exit/i.test(cleaned)
  );
}

/**
 * Ring buffer for PTY output. Replaces tmux capture-pane.
 * Stores raw output chunks and provides search/retrieval with ANSI stripping.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private maxChunks: number;
  private logPath: string | null;
  private bootstrapPattern: string;
  /**
   * Latched once the bootstrap pattern has matched for real. Both first-run
   * guards below are then permanently disarmed: a trust or bypass screen cannot
   * legitimately reappear after the status bar has once shown, so leaving the
   * guards live for the life of the session only creates a way for ordinary
   * agent output to un-bootstrap a running agent. One OutputBuffer is created
   * per PTY spawn, so this resets with the session, as it should.
   */
  private everMatchedBootstrap = false;

  constructor(maxChunks: number = 1000, logPath?: string, bootstrapPattern?: string) {
    this.maxChunks = maxChunks;
    this.logPath = logPath || null;
    this.bootstrapPattern = bootstrapPattern || 'permissions';
  }

  /**
   * Push new output data into the buffer.
   * Also streams to log file if configured.
   *
   * Secret redaction runs once at the top via `redactSecrets` and the
   * scrubbed string is used for BOTH the in-memory ring buffer AND the
   * disk log. Without this, any JWT or session cookie an agent's shell
   * happens to print (e.g. curl -v against an authenticated endpoint)
   * would end up persisted to stdout.log verbatim. See src/pty/redact.ts
   * for the rationale + the known chunk-boundary limitation.
   */
  push(data: string): void {
    const safe = redactSecrets(data);

    this.chunks.push(safe);
    if (this.chunks.length > this.maxChunks) {
      this.chunks.shift();
    }

    // Stream to log file (replaces tmux pipe-pane)
    if (this.logPath) {
      try {
        try {
          const size = statSync(this.logPath).size;
          if (size >= MAX_LOG_BYTES) {
            try { renameSync(this.logPath, this.logPath + '.1'); } catch { /* ignore */ }
          }
        } catch { /* file doesn't exist yet — skip rotation check */ }
        appendFileSync(this.logPath, safe, 'utf-8');
      } catch {
        // Ignore log write errors
      }
    }
  }

  /**
   * Get the last N chunks of output joined together.
   */
  getRecent(n?: number): string {
    const count = n || this.chunks.length;
    return this.chunks.slice(-count).join('');
  }

  /**
   * Search for a pattern in recent output (ANSI codes stripped).
   * Used for bootstrap detection ("permissions" text).
   */
  async search(pattern: string): Promise<boolean> {
    const strip = await loadStripAnsi();
    const text = strip(this.getRecent());
    return text.includes(pattern);
  }

  /**
   * Synchronous search for simple patterns.
   * Does basic ANSI stripping inline (strips ESC[ sequences).
   */
  searchSync(pattern: string): boolean {
    const text = this.getRecent().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    return text.includes(pattern);
  }

  /**
   * Check if agent has bootstrapped (ready-for-input signal appeared).
   *
   * For Claude Code: looks for the "permissions" status-bar text.
   * For Hermes: looks for the "❯" prompt character (configurable via constructor).
   * The bootstrap pattern is set at construction time by the PTY class.
   */
  isBootstrapped(): boolean {
    const recent = this.getRecent();
    const cleaned = recent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const matched = cleaned.includes(this.bootstrapPattern);

    // First-run false-positive guards. Skipped once bootstrap has genuinely
    // matched (see everMatchedBootstrap) so they can only ever suppress DURING
    // first boot, never for a live session.
    if (this.bootstrapPattern === 'permissions' && !this.everMatchedBootstrap) {
      // Claude Code: exclude trust-folder prompt false positives.
      // The trust prompt shows "trust this folder" before the status bar appears.
      if (cleaned.includes('trust') && !cleaned.includes('> ')) {
        return false;
      }
      // Bypass Permissions screen (closes the KNOWN GAP left by PR #1's
      // fresh-eyes review): while it shows, the agent is NOT up. Without this,
      // a future lowercase "permissions" on that screen would satisfy the match
      // below, the auto-accept poll in agent-pty.ts would clear itself before
      // reaching its bypass branch so Down+Enter is never sent, AND the
      // awaitingConfirmation backstop (also gated on !isBootstrapped) would stay
      // silent — the wedge would report as "running".
      if (isShowingBypassScreen(cleaned)) {
        return false;
      }
    }

    if (matched) this.everMatchedBootstrap = true;
    return matched;
  }

  /**
   * Get the total size of buffered output in bytes.
   * Useful for activity detection (typing indicator).
   */
  getSize(): number {
    let size = 0;
    for (const chunk of this.chunks) {
      size += chunk.length;
    }
    return size;
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.chunks = [];
  }
}
