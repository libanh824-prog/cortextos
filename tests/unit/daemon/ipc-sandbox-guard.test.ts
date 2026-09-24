import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

import { instanceDefaultRoot, sandboxedRootMismatch } from '../../../src/utils/paths.js';
import { IPCClient, IPCServer } from '../../../src/daemon/ipc-server.js';

/**
 * Guard for the asymmetry between state resolution and socket resolution:
 * CTX_ROOT redirects state (src/bus/crons.ts, src/daemon/cron-scheduler.ts) but
 * NOT the IPC socket path (getIpcPath derives from the instance id alone), so a
 * run that sandboxes only CTX_ROOT still reaches the LIVE fleet daemon.
 */
const originalCtxRoot = process.env.CTX_ROOT;
let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ipc-guard-'));
});

afterEach(() => {
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
  vi.restoreAllMocks();
});

describe('sandboxedRootMismatch', () => {
  it('returns null when CTX_ROOT is unset (production CLI from a plain shell)', () => {
    delete process.env.CTX_ROOT;
    expect(sandboxedRootMismatch('default')).toBeNull();
  });

  it('returns null when CTX_ROOT equals the instance root (production agents + daemon)', () => {
    // Positive control for the live fleet: the daemon and every agent shell run
    // with CTX_ROOT=~/.cortextos/<instance>, so the guard must be inert there.
    process.env.CTX_ROOT = join(homedir(), '.cortextos', 'default');
    expect(sandboxedRootMismatch('default')).toBeNull();
  });

  it('tolerates a trailing separator and a non-normalised path', () => {
    process.env.CTX_ROOT = join(homedir(), '.cortextos', 'default') + '/';
    expect(sandboxedRootMismatch('default')).toBeNull();
    process.env.CTX_ROOT = join(homedir(), '.cortextos', 'default', '.', '');
    expect(sandboxedRootMismatch('default')).toBeNull();
  });

  it('reports a mismatch when CTX_ROOT points elsewhere', () => {
    process.env.CTX_ROOT = sandbox;
    const reason = sandboxedRootMismatch('default');
    expect(reason).toBeTruthy();
    // The message must name BOTH paths — a reader has to be able to see which
    // side is wrong without re-deriving either.
    expect(reason).toContain(sandbox);
    expect(reason).toContain(instanceDefaultRoot('default'));
  });

  it('is instance-aware: the same CTX_ROOT is consistent for its own instance', () => {
    process.env.CTX_ROOT = instanceDefaultRoot('sandbox-a');
    expect(sandboxedRootMismatch('sandbox-a')).toBeNull();
    expect(sandboxedRootMismatch('default')).toBeTruthy();
  });
});

describe('IPC refuses to cross a sandboxed root', () => {
  it('IPCClient.send refuses rather than commanding the live daemon', async () => {
    process.env.CTX_ROOT = sandbox;
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new IPCClient('default');
    await expect(
      client.send({ type: 'reload-crons', agent: 'boris' } as never),
    ).rejects.toThrow(/refusing to use that instance's IPC socket/);
    // Suppression must be visible: signalCronReload swallows errors by design.
    expect(warn).toHaveBeenCalled();
  });

  it('IPCServer.start refuses BEFORE it can unlink the live socket', async () => {
    process.env.CTX_ROOT = sandbox;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = new IPCServer({} as never, 'default');
    await expect(server.start()).rejects.toThrow(/refusing to use that instance's IPC socket/);
    expect(err).toHaveBeenCalled();
  });

  it('constructing either class is still harmless under a sandbox', () => {
    // Construction only computes a path. Existing tests build an IPCServer with a
    // tempdir CTX_ROOT purely to exercise other code, so the guard must live on
    // the ACT (start/send), not the constructor.
    process.env.CTX_ROOT = sandbox;
    expect(() => new IPCClient('default')).not.toThrow();
    expect(() => new IPCServer({} as never, 'default')).not.toThrow();
  });
});
