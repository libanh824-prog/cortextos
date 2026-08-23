/**
 * keep_rate basis + entry_kind classification (task_1787447155110_46930285).
 *
 * Fixture replicates analyst's REAL register shape (2026-08-23): 47 completed
 * system_effectiveness cycle logs (unanimous keeps, legacy = no entry_kind)
 * + 2 genuine interventions (1 keep, 1 discard), the real ids, asserted BY ID
 * per analyst's pre-registration: n=2, keeps=1, discards=1, rate=0.50.
 */
import { vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  gatherContext, classifyEntryKind, createExperiment, runExperiment,
  evaluateExperiment, manageCycle, RETIRED_METRICS,
} from '../src/bus/experiment';

const testDir = join(tmpdir(), `keeprate-test-${process.pid}`);
const histDir = join(testDir, 'experiments', 'history');

const KEEP_ID = 'exp_1786954090_0tgsk';
const DISCARD_ID = 'exp_1786954407_tsj44';

function writeExp(id: string, metric: string, decision: 'keep' | 'discard', extra: Record<string, unknown> = {}) {
  writeFileSync(join(histDir, `${id}.json`), JSON.stringify({
    id, agent: 'analyst', metric, hypothesis: 'h', surface: '', direction: 'higher',
    window: '24h', measurement: '', status: 'completed', baseline_value: 0,
    result_value: 1, decision, learning: '', experiment_commit: null,
    tracking_commit: null, created_at: '2026-08-01T00:00:00Z',
    started_at: '2026-08-01T00:00:00Z', completed_at: '2026-08-02T00:00:00Z',
    changes_description: null, ...extra,
  }, null, 2));
}

beforeEach(() => { mkdirSync(histDir, { recursive: true }); });
afterEach(() => { try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function buildAnalystShape() {
  for (let i = 0; i < 47; i++) writeExp(`exp_17869${String(10000 + i)}_cyc${String(i).padStart(2, '0')}`, 'system_effectiveness', 'keep');
  writeExp(KEEP_ID, 'brand_bridge_false_match_rate_synthetic_negatives', 'keep');
  writeExp(DISCARD_ID, 'cross_market_auto_match_precision', 'discard');
}

describe('keep_rate over interventions (analyst real shape)', () => {
  it('matches the pre-registered values: n=2, keeps=1, discards=1, rate=0.50', () => {
    buildAnalystShape();
    const ctx = gatherContext(testDir, 'analyst');
    expect(ctx.total_experiments).toBe(49);
    expect(ctx.keeps).toBe(1);
    expect(ctx.discards).toBe(1);
    expect(ctx.keep_rate).toBe(0.5);
    expect(ctx.keep_rate_basis.n).toBe(2);
    expect(ctx.keep_rate_basis.excluded_cycle_logs).toBe(47);
    expect(ctx.keep_rate_basis.classified_by_legacy_metric_rule).toBe(2);
    expect(ctx.keep_rate_basis.classified_by_entry_kind).toBe(0);
  });

  it('the two named interventions survive the filter BY ID', () => {
    buildAnalystShape();
    for (const id of [KEEP_ID, DISCARD_ID]) {
      const e = JSON.parse(readFileSync(join(histDir, `${id}.json`), 'utf-8'));
      expect(classifyEntryKind(e)).toBe('intervention');
    }
    const cyc = JSON.parse(readFileSync(join(histDir, 'exp_1786910000_cyc00.json'), 'utf-8'));
    expect(classifyEntryKind(cyc)).toBe('cycle_log');
  });

  it('entry_kind PROPERTY beats the legacy metric rule in both directions', () => {
    // a cycle log under a NEW metric name (the denylist limit) — property catches it
    writeExp('exp_1786900001_newcl', 'shiny_new_cycle_metric', 'keep', { entry_kind: 'cycle_log' });
    // an intervention that happens to use a retired NAME — property wins
    writeExp('exp_1786900002_realx', 'system_effectiveness', 'discard', { entry_kind: 'intervention' });
    const ctx = gatherContext(testDir, 'analyst');
    expect(ctx.keep_rate_basis.n).toBe(1);
    expect(ctx.discards).toBe(1);
    expect(ctx.keeps).toBe(0);
  });
});

describe('entry_kind at create', () => {
  it('cycle-configured metric => cycle_log; plain metric => intervention; option overrides', () => {
    manageCycle(testDir, 'create', { name: 'c1', agent: 'testbot', metric: 'cycle_metric' });
    const cycId = createExperiment(testDir, 'testbot', 'cycle_metric', 'h');
    const intId = createExperiment(testDir, 'testbot', 'one_off_metric', 'h');
    const ovId = createExperiment(testDir, 'testbot', 'cycle_metric', 'h', { entry_kind: 'intervention' });
    const read = (id: string) => JSON.parse(readFileSync(join(histDir, `${id}.json`), 'utf-8'));
    expect(read(cycId).entry_kind).toBe('cycle_log');
    expect(read(intId).entry_kind).toBe('intervention');
    expect(read(ovId).entry_kind).toBe('intervention');
  });
});

describe('experiment_commit at completion', () => {
  it('caller-named sha is recorded; malformed sha throws; missing sha on an intervention warns visibly', () => {
    const id = createExperiment(testDir, 'testbot', 'm1', 'h');
    runExperiment(testDir, id);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const done = evaluateExperiment(testDir, id, 5, { commit: 'abc1234def' });
    expect(done.experiment_commit).toBe('abc1234def');
    expect(spy).not.toHaveBeenCalled();

    const id2 = createExperiment(testDir, 'testbot', 'm2', 'h');
    runExperiment(testDir, id2);
    expect(() => evaluateExperiment(testDir, id2, 5, { commit: 'not-a-sha!' })).toThrow(/does not look like a git sha/);
    evaluateExperiment(testDir, id2, 5, {});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('WITHOUT --commit'));
    spy.mockRestore();
  });

  it('a cycle_log completing without a commit does NOT warn (link is an intervention concept)', () => {
    manageCycle(testDir, 'create', { name: 'c2', agent: 'testbot', metric: 'cm2' });
    const id = createExperiment(testDir, 'testbot', 'cm2', 'h');
    runExperiment(testDir, id);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    evaluateExperiment(testDir, id, 5, {});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('retired list is legacy-only documentation', () => {
  it('exports the retired set for auditability', () => {
    expect(RETIRED_METRICS).toContain('system_effectiveness');
  });
});

describe('entry_kind at create — analyst regression fixtures (2026-08-23)', () => {
  it('theta_wave.metric with EMPTY cycles[] stamps cycle_log (the real analyst shape)', () => {
    mkdirSync(join(testDir, 'experiments'), { recursive: true });
    writeFileSync(join(testDir, 'experiments', 'config.json'), JSON.stringify({
      approval_required: false, cycles: [],
      theta_wave: { enabled: true, interval: '24h', metric: 'system_effectiveness' },
    }));
    const id = createExperiment(testDir, 'analyst', 'system_effectiveness', 'cycle assessment');
    const e = JSON.parse(readFileSync(join(histDir, `${id}.json`), 'utf-8'));
    expect(e.entry_kind).toBe('cycle_log');
    expect(classifyEntryKind(e)).toBe('cycle_log');
  });

  it('a RETIRED metric stamps cycle_log even with no config at all', () => {
    const id = createExperiment(testDir, 'anyagent', 'system_effectiveness', 'h');
    const e = JSON.parse(readFileSync(join(histDir, `${id}.json`), 'utf-8'));
    expect(e.entry_kind).toBe('cycle_log');
  });

  it('explicit entry_kind option still overrides the cycle-metric derivation', () => {
    const id = createExperiment(testDir, 'anyagent', 'system_effectiveness', 'h', { entry_kind: 'intervention' });
    const e = JSON.parse(readFileSync(join(histDir, `${id}.json`), 'utf-8'));
    expect(e.entry_kind).toBe('intervention');
  });
});
