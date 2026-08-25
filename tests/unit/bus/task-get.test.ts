/**
 * Read-only get-task + incomplete-vs-missing miss messages
 * (task_1787541122762_78070002).
 *
 * The gap: verifying one task id meant pull-all + client-filter, and the only
 * exact-match resolver lived on the WRITE path (update-task), whose miss said
 * "not found in any org" — reading as does-not-exist when the operator was
 * actually holding a truncated id copied from a rendered table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths, Task } from '../../../src/types';
import { getTask, findTaskIdsByPrefix, taskMissMessage, updateTask } from '../../../src/bus/task';

let root: string;
let paths: BusPaths;

const FULL_ID = 'task_1787541122762_78070002';
const TRUNCATED = 'task_1787541122762_7807'; // what a cut-off table cell yields
const SIBLING_ID = 'task_1787541122762_78079999'; // shares the truncated prefix

function mkPaths(r: string): BusPaths {
  return {
    ctxRoot: r,
    inbox: join(r, 'inbox'),
    inflight: join(r, 'inflight'),
    processed: join(r, 'processed'),
    logDir: join(r, 'logs'),
    stateDir: join(r, 'state'),
    taskDir: join(r, 'orgs', 'orgA', 'tasks'),
    approvalDir: join(r, 'orgs', 'orgA', 'approvals'),
    analyticsDir: join(r, 'analytics'),
    heartbeatDir: join(r, 'heartbeats'),
  };
}

function writeTask(org: string, id: string, extra: Partial<Task> = {}): string {
  const dir = join(root, 'orgs', org, 'tasks');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify({
    id, title: 't', description: '', type: 'agent', needs_approval: false,
    status: 'pending', assigned_to: 'dev', created_by: 'chief', org,
    priority: 'low', project: '', kpi_key: null,
    created_at: '2026-08-24T03:12:02Z', updated_at: '2026-08-24T03:12:02Z',
    completed_at: null, due_date: null, archived: false, ...extra,
  }));
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortextos-gettask-'));
  paths = mkPaths(root);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('getTask (read-only exact lookup)', () => {
  it('returns the task from the own-org fast path', () => {
    writeTask('orgA', FULL_ID);
    expect(getTask(paths, FULL_ID)?.id).toBe(FULL_ID);
  });

  it('returns the task via cross-org scan', () => {
    writeTask('orgB', FULL_ID);
    expect(getTask(paths, FULL_ID)?.id).toBe(FULL_ID);
  });

  it('NEVER writes: file bytes and mtime unchanged after lookup — the update-task foot-gun this exists to remove', () => {
    const file = writeTask('orgA', FULL_ID);
    const before = { mtime: statSync(file).mtimeMs, bytes: readFileSync(file, 'utf-8') };
    getTask(paths, FULL_ID);
    expect(statSync(file).mtimeMs).toBe(before.mtime);
    expect(readFileSync(file, 'utf-8')).toBe(before.bytes);
    // Positive control on the harness: the write path DOES move the file,
    // so an unchanged-file assertion is capable of failing here.
    updateTask(paths, FULL_ID, 'in_progress');
    expect(readFileSync(file, 'utf-8')).not.toBe(before.bytes);
  });

  it('missing id returns null (file absent)', () => {
    expect(getTask(paths, FULL_ID)).toBeNull();
  });

  it('corrupt file THROWS naming the path — a corrupt record must not read as missing', () => {
    const dir = join(root, 'orgs', 'orgA', 'tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${FULL_ID}.json`), '{"id": "task_178754');
    expect(() => getTask(paths, FULL_ID)).toThrow(/could not be parsed/);
    expect(() => getTask(paths, FULL_ID)).toThrow(new RegExp(FULL_ID));
  });
});

describe('incomplete-vs-missing miss messages', () => {
  it('truncated id: message names the full candidate id(s) and says TRUNCATED', () => {
    writeTask('orgA', FULL_ID);
    writeTask('orgB', SIBLING_ID);
    const msg = taskMissMessage(paths, TRUNCATED);
    expect(msg).toContain(FULL_ID);
    expect(msg).toContain(SIBLING_ID);
    expect(msg).toContain('TRUNCATED');
    expect(msg).not.toContain('does not exist');
  });

  it('genuinely absent id: message says does-not-exist and rules OUT truncation', () => {
    writeTask('orgA', FULL_ID);
    const msg = taskMissMessage(paths, 'task_9999999999999_00000000');
    expect(msg).toContain('does not exist');
    expect(msg).toContain('not a truncation');
    expect(msg).not.toContain('TRUNCATED');
  });

  it('the two branches are distinguishable — no shared both-ways wording', () => {
    writeTask('orgA', FULL_ID);
    const truncated = taskMissMessage(paths, TRUNCATED);
    const absent = taskMissMessage(paths, 'task_1111111111111_22222222');
    expect(truncated).not.toBe(absent);
  });

  it('an EXACT id is never suggested as its own prefix match', () => {
    writeTask('orgA', FULL_ID);
    expect(findTaskIdsByPrefix(paths, FULL_ID)).toEqual([]);
  });

  it('write-path miss (updateTask) now carries the truncation hint', () => {
    writeTask('orgA', FULL_ID);
    expect(() => updateTask(paths, TRUNCATED, 'in_progress')).toThrow(/TRUNCATED/);
  });

  it('prefix scan respects the limit', () => {
    for (let i = 0; i < 15; i++) writeTask('orgA', `task_1700000000000_${String(10000000 + i)}`);
    expect(findTaskIdsByPrefix(paths, 'task_1700000000000_', 10)).toHaveLength(10);
  });
});
