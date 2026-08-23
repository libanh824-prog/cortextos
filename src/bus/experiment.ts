import { readdirSync, readFileSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';

// --- Types ---

export interface Experiment {
  id: string;
  agent: string;
  metric: string;
  /** What this entry IS: an intervention tested against a metric, or a
   *  periodic cycle log. Optional because entries predating 2026-08-23 lack
   *  it — those are classified at read time by classifyEntryKind(). */
  entry_kind?: 'intervention' | 'cycle_log';
  hypothesis: string;
  surface: string;
  direction: 'higher' | 'lower';
  window: string;
  measurement: string;
  status: 'proposed' | 'running' | 'completed';
  baseline_value: number;
  result_value: number | null;
  decision: 'keep' | 'discard' | null;
  learning: string;
  experiment_commit: string | null;
  tracking_commit: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  changes_description: string | null;
}

export interface ExperimentCreateOptions {
  surface?: string;
  direction?: 'higher' | 'lower';
  window?: string;
  measurement?: string;
  approval_required?: boolean;
  entry_kind?: 'intervention' | 'cycle_log';
}

export interface ExperimentEvaluateOptions {
  learning?: string;
  score?: number;
  /** The sha of the change this intervention landed as. Caller-named ONLY —
   *  never inferred from any repo's HEAD (a wrong sha reads as verified;
   *  null is legible as missing). Legacy rows stay null = UNKNOWN. */
  commit?: string;
  justification?: string;
}

export interface ExperimentFilters {
  status?: string;
  metric?: string;
  agent?: string;
}

export interface GatherContextOptions {
  format?: 'json' | 'markdown';
}

export interface ExperimentContext {
  agent: string;
  total_experiments: number;
  /** keeps/discards/keep_rate are computed over COMPLETED INTERVENTIONS only
   *  (cycle logs and retired-metric entries excluded) — see keep_rate_basis. */
  keeps: number;
  discards: number;
  keep_rate: number;
  /** The rate's own evidence: what population it was computed over and how
   *  each member was classified. A bare rate is a verdict without evidence. */
  keep_rate_basis: {
    population: string;
    n: number;
    classified_by_entry_kind: number;
    classified_by_legacy_metric_rule: number;
    excluded_cycle_logs: number;
  };
  learnings: string;
  results_tsv: string;
  identity: string;
  goals: string;
}

export interface ExperimentCycle {
  name: string;
  agent: string;
  metric: string;
  metric_type: 'quantitative' | 'qualitative';
  surface: string;
  direction: 'higher' | 'lower';
  window: string;
  measurement: string;
  loop_interval: string;
  enabled: boolean;
  created_by: string;
  created_at: string;
}

export interface ExperimentConfig {
  approval_required?: boolean;
  cycles?: ExperimentCycle[];
  theta_wave?: {
    enabled?: boolean;
    interval?: string;
    metric?: string;
    metric_type?: string;
    direction?: string;
    auto_create_agent_cycles?: boolean;
    auto_modify_agent_cycles?: boolean;
  };
  monitoring?: Record<string, unknown>;
}

// --- Helpers ---

function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function historyDir(agentDir: string): string {
  return join(agentDir, 'experiments', 'history');
}

function loadExperiment(agentDir: string, experimentId: string): Experiment {
  const filePath = join(historyDir(agentDir), `${experimentId}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Experiment ${experimentId} not found`);
  }
  return JSON.parse(readFileSync(filePath, 'utf-8').trim());
}

function saveExperiment(agentDir: string, experiment: Experiment): void {
  const dir = historyDir(agentDir);
  ensureDir(dir);
  atomicWriteSync(join(dir, `${experiment.id}.json`), JSON.stringify(experiment, null, 2));
}

export function loadExperimentConfig(agentDir: string): ExperimentConfig {
  return loadConfig(agentDir);
}

function loadConfig(agentDir: string): ExperimentConfig {
  const configPath = join(agentDir, 'experiments', 'config.json');
  if (!existsSync(configPath)) {
    return {};
  }
  return JSON.parse(readFileSync(configPath, 'utf-8').trim());
}

function saveConfig(agentDir: string, config: ExperimentConfig): void {
  const dir = join(agentDir, 'experiments');
  ensureDir(dir);
  atomicWriteSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

// --- Public API ---

/**
 * Create a new experiment proposal.
 *
 * Fields with no explicit option fall back to the matching cycle in
 * `experiments/config.json` (same metric + same agent) before using the
 * static default. The autoresearch skill registers its measurement method,
 * direction, window, and surface once in the cycle config; with the cycle
 * fallback, repeat experiments on that metric stop losing the measurement
 * description because the agent forgot to pass --measurement.
 * Explicit options always win over the cycle so ad-hoc overrides still work.
 */
export function createExperiment(
  agentDir: string,
  agentName: string,
  metric: string,
  hypothesis: string,
  options?: ExperimentCreateOptions,
): string {
  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const id = `exp_${epoch}_${rand}`;

  const cycleDefaults = findCycleDefaults(agentDir, agentName, metric);
  // entry_kind at CREATE: explicit option wins; else a CYCLE METRIC is a
  // cycle log, anything else is an intervention. Property set at write time
  // so reads never need the legacy denylist for new entries.
  //
  // "Cycle metric" must be decided from EVERY place cycle metrics live, not
  // just cycles[] (analyst regression 2026-08-23: cycles was EMPTY and the
  // theta-wave metric lives at config.theta_wave.metric, so new
  // system_effectiveness entries were stamped 'intervention' and the
  // property — correctly beating the legacy rule — carried the wrong value
  // into the rate forever). Fix at the SOURCE: cycles[] match OR the
  // configured theta_wave.metric OR a RETIRED metric (retired BECAUSE they
  // were cycle scores; a new entry under one is a cycle log by definition).
  const twMetric = (() => {
    try { return loadConfig(agentDir).theta_wave?.metric; } catch { return undefined; }
  })();
  const isCycleMetric =
    Boolean(cycleDefaults.matched) || metric === twMetric || RETIRED_METRICS.includes(metric);
  const entryKind: 'intervention' | 'cycle_log' =
    options?.entry_kind ?? (isCycleMetric ? 'cycle_log' : 'intervention');

  const experiment: Experiment = {
    id,
    agent: agentName,
    metric,
    entry_kind: entryKind,
    hypothesis,
    surface: options?.surface ?? cycleDefaults.surface ?? '',
    direction: options?.direction ?? cycleDefaults.direction ?? 'higher',
    window: options?.window ?? cycleDefaults.window ?? '24h',
    measurement: options?.measurement ?? cycleDefaults.measurement ?? '',
    status: 'proposed',
    baseline_value: 0,
    result_value: null,
    decision: null,
    learning: '',
    experiment_commit: null,
    tracking_commit: null,
    created_at: nowISO(),
    started_at: null,
    completed_at: null,
    changes_description: null,
  };

  saveExperiment(agentDir, experiment);

  return id;
}

/**
 * Look up cycle-level defaults for a new experiment on the given metric.
 * Matches a cycle by metric + agent. Returns an empty object if no cycle
 * is configured — createExperiment then falls through to its static
 * defaults. Best-effort: any config-read error returns empty so the
 * experiment create path never breaks on malformed config.
 */
function findCycleDefaults(
  agentDir: string,
  agentName: string,
  metric: string,
): Partial<Pick<ExperimentCreateOptions, 'surface' | 'direction' | 'window' | 'measurement'>> & { matched?: boolean } {
  try {
    const config = loadConfig(agentDir);
    const cycle = config.cycles?.find(
      (c) => c.metric === metric && c.agent === agentName,
    );
    if (!cycle) return {};
    return {
      matched: true,
      surface: cycle.surface || undefined,
      direction: cycle.direction || undefined,
      window: cycle.window || undefined,
      measurement: cycle.measurement || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Start running a proposed experiment.
 */
export function runExperiment(
  agentDir: string,
  experimentId: string,
  changesDescription?: string,
): Experiment {
  const experiment = loadExperiment(agentDir, experimentId);

  if (experiment.status !== 'proposed') {
    throw new Error(`Experiment ${experimentId} is '${experiment.status}', expected 'proposed'`);
  }

  experiment.status = 'running';
  experiment.started_at = nowISO();
  if (changesDescription) {
    experiment.changes_description = changesDescription;
  }

  saveExperiment(agentDir, experiment);

  // Write active.json
  const activeDir = join(agentDir, 'experiments');
  ensureDir(activeDir);
  atomicWriteSync(join(activeDir, 'active.json'), JSON.stringify(experiment, null, 2));

  return experiment;
}

/**
 * Evaluate a running experiment with a measured value.
 */
export function evaluateExperiment(
  agentDir: string,
  experimentId: string,
  measuredValue: number,
  options?: ExperimentEvaluateOptions,
): Experiment {
  const experiment = loadExperiment(agentDir, experimentId);

  if (experiment.status !== 'running') {
    throw new Error(`Experiment ${experimentId} is '${experiment.status}', expected 'running'`);
  }

  // experiment_commit: the landed-change link that makes the decision
  // VERIFIABLE rather than merely claimed. Caller-named sha only.
  if (options?.commit) {
    if (!/^[0-9a-f]{7,40}$/i.test(options.commit)) {
      throw new Error(`--commit '${options.commit}' does not look like a git sha (7-40 hex chars)`);
    }
    experiment.experiment_commit = options.commit;
  } else if (classifyEntryKind(experiment) === 'intervention' && !experiment.experiment_commit) {
    // Visible, not fatal: an intervention completed without a commit link is
    // a decision the register can never verify LANDED. Say so at the moment
    // it happens rather than discovering 49 nulls in an audit.
    console.error(
      `evaluate-experiment: ${experimentId} completed WITHOUT --commit — ` +
      'decision recorded without a landed-change link; the round-trip is unverifiable from the register.'
    );
  }

  // Compare measured vs baseline using direction
  let decision: 'keep' | 'discard';
  if (experiment.direction === 'higher') {
    decision = measuredValue > experiment.baseline_value ? 'keep' : 'discard';
  } else {
    decision = measuredValue < experiment.baseline_value ? 'keep' : 'discard';
  }

  experiment.status = 'completed';
  experiment.completed_at = nowISO();
  experiment.result_value = measuredValue;
  experiment.decision = decision;

  // For qualitative metrics: if score is provided, use it as the measured value
  // (agent passes 0 as placeholder measuredValue and --score 7 as the actual value)
  if (options?.score !== undefined) {
    measuredValue = options.score;
    // Re-evaluate decision with the correct measured value
    if (experiment.direction === 'higher') {
      decision = measuredValue > experiment.baseline_value ? 'keep' : 'discard';
    } else {
      decision = measuredValue < experiment.baseline_value ? 'keep' : 'discard';
    }
    experiment.result_value = measuredValue;
    experiment.decision = decision;
  }

  // Build learning from options
  const learningParts: string[] = [];
  if (options?.learning) learningParts.push(options.learning);
  if (options?.justification) learningParts.push(options.justification);
  if (learningParts.length > 0) {
    experiment.learning = learningParts.join(' — ');
  }

  // If keep, baseline becomes the measured value
  if (decision === 'keep') {
    experiment.baseline_value = measuredValue;
  }

  saveExperiment(agentDir, experiment);

  // Append to results.tsv
  const expDir = join(agentDir, 'experiments');
  ensureDir(expDir);
  const tsvPath = join(expDir, 'results.tsv');
  if (!existsSync(tsvPath)) {
    appendFileSync(
      tsvPath,
      'experiment_id\tagent\tmetric\tmeasured_value\tbaseline\tdecision\thypothesis\ttimestamp\n',
      'utf-8',
    );
  }
  const tsvLine = [
    experiment.id,
    experiment.agent,
    experiment.metric,
    String(measuredValue),
    String(decision === 'keep' ? measuredValue : experiment.baseline_value),
    decision,
    experiment.hypothesis,
    experiment.completed_at,
  ].join('\t');
  appendFileSync(tsvPath, tsvLine + '\n', 'utf-8');

  // Append to learnings.md
  const learningsPath = join(expDir, 'learnings.md');
  if (!existsSync(learningsPath)) {
    appendFileSync(learningsPath, '# Experiment Learnings\n\n', 'utf-8');
  }
  const learningEntry = [
    `## ${experiment.id} (${decision})`,
    `- **Metric:** ${experiment.metric}`,
    `- **Hypothesis:** ${experiment.hypothesis}`,
    `- **Result:** ${measuredValue} (baseline: ${decision === 'keep' ? measuredValue : experiment.baseline_value})`,
    experiment.learning ? `- **Learning:** ${experiment.learning}` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  appendFileSync(learningsPath, learningEntry + '\n', 'utf-8');

  // Remove active.json
  const activePath = join(expDir, 'active.json');
  if (existsSync(activePath)) {
    try {
      unlinkSync(activePath);
    } catch {
      // ignore
    }
  }

  return experiment;
}

/**
 * List experiments with optional filters.
 */
/**
 * Metrics RETIRED from intervention accounting. system_effectiveness was the
 * 1-10 compound score retired at TW#61 (2026-08-19) for emitting 9 on 87% of
 * cycles; its 47 unanimous "keeps" were cycle logs, not tested interventions.
 *
 * HONEST LIMIT: this is a DENYLIST and only classifies LEGACY entries (those
 * without entry_kind, all predating 2026-08-23). A legacy-era cycle log under
 * a metric name not listed here slips through as an intervention. Entries
 * created after entry_kind existed carry the property and never touch this
 * list. Do not extend this list as a substitute for setting entry_kind.
 */
export const RETIRED_METRICS = ['system_effectiveness'];

/**
 * Classify an entry from its PROPERTY when present; the metric-name denylist
 * is strictly the legacy fallback (fix-the-source-not-the-proxy: the field is
 * authoritative, the name rule exists only because old rows carry no field).
 */
export function classifyEntryKind(e: Experiment): 'intervention' | 'cycle_log' {
  if (e.entry_kind) return e.entry_kind;
  return RETIRED_METRICS.includes(e.metric) ? 'cycle_log' : 'intervention';
}

export function listExperiments(
  agentDir: string,
  filters?: ExperimentFilters,
): Experiment[] {
  const dir = historyDir(agentDir);
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  let experiments: Experiment[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8').trim();
      experiments.push(JSON.parse(content));
    } catch {
      // skip corrupt files
    }
  }

  if (filters?.status) {
    experiments = experiments.filter(e => e.status === filters.status);
  }
  if (filters?.metric) {
    experiments = experiments.filter(e => e.metric === filters.metric);
  }
  if (filters?.agent) {
    experiments = experiments.filter(e => e.agent === filters.agent);
  }

  // Sort by created_at desc
  experiments.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return experiments;
}

/**
 * Gather experiment context for an agent: learnings, stats, identity, goals.
 */
export function gatherContext(
  agentDir: string,
  agentName: string,
  _options?: GatherContextOptions,
): ExperimentContext {
  const expDir = join(agentDir, 'experiments');

  // Read learnings
  const learningsPath = join(expDir, 'learnings.md');
  const learnings = existsSync(learningsPath) ? readFileSync(learningsPath, 'utf-8') : '';

  // Read results TSV
  const tsvPath = join(expDir, 'results.tsv');
  const resultsTsv = existsSync(tsvPath) ? readFileSync(tsvPath, 'utf-8') : '';

  // Calculate stats from history
  const all = listExperiments(agentDir);
  const completed = all.filter(e => e.status === 'completed');
  // Rate over COMPLETED INTERVENTIONS only. Cycle logs (47/49 of analyst's
  // register as of 2026-08-23, unanimous keeps by construction) made the
  // headline 0.98 while the tested-intervention truth was 0.50 — a
  // population that has never dissented is not evidence about interventions.
  const completedInterventions = completed.filter(e => classifyEntryKind(e) === 'intervention');
  const keeps = completedInterventions.filter(e => e.decision === 'keep').length;
  const discards = completedInterventions.filter(e => e.decision === 'discard').length;
  const total = all.length;
  const keepRate = completedInterventions.length > 0 ? keeps / completedInterventions.length : 0;
  const keepRateBasis = {
    population: 'completed interventions (cycle logs + retired-metric legacy entries excluded)',
    n: completedInterventions.length,
    classified_by_entry_kind: completedInterventions.filter(e => e.entry_kind).length,
    classified_by_legacy_metric_rule: completedInterventions.filter(e => !e.entry_kind).length,
    excluded_cycle_logs: completed.length - completedInterventions.length,
  };

  // Read agent IDENTITY.md and GOALS.md
  const identityPath = join(agentDir, 'IDENTITY.md');
  const identity = existsSync(identityPath) ? readFileSync(identityPath, 'utf-8') : '';

  const goalsPath = join(agentDir, 'GOALS.md');
  const goals = existsSync(goalsPath) ? readFileSync(goalsPath, 'utf-8') : '';

  return {
    agent: agentName,
    total_experiments: total,
    keeps,
    discards,
    keep_rate: keepRate,
    keep_rate_basis: keepRateBasis,
    learnings,
    results_tsv: resultsTsv,
    identity,
    goals,
  };
}

/**
 * Manage experiment cycles in config.json.
 */
export function manageCycle(
  agentDir: string,
  action: 'create' | 'modify' | 'remove' | 'list',
  options: {
    agent?: string;
    name?: string;
    metric?: string;
    metric_type?: 'quantitative' | 'qualitative';
    surface?: string;
    direction?: 'higher' | 'lower';
    window?: string;
    measurement?: string;
    loop_interval?: string;
    enabled?: boolean;
  },
): ExperimentCycle[] {
  const config = loadConfig(agentDir);
  if (!config.cycles) {
    config.cycles = [];
  }

  switch (action) {
    case 'create': {
      if (!options.name || !options.agent || !options.metric) {
        throw new Error('Cycle create requires name, agent, and metric');
      }
      const cycle: ExperimentCycle = {
        name: options.name,
        agent: options.agent,
        metric: options.metric,
        metric_type: options.metric_type || 'qualitative',
        surface: options.surface || '',
        direction: options.direction || 'higher',
        window: options.window || '24h',
        measurement: options.measurement || '',
        loop_interval: options.loop_interval || options.window || '24h',
        enabled: true,
        created_by: options.agent,
        created_at: nowISO(),
      };
      config.cycles.push(cycle);
      saveConfig(agentDir, config);
      return config.cycles;
    }

    case 'modify': {
      if (!options.name) {
        throw new Error('Cycle modify requires name');
      }
      const idx = config.cycles.findIndex(c => c.name === options.name);
      if (idx === -1) {
        throw new Error(`Cycle '${options.name}' not found`);
      }
      if (options.metric) config.cycles[idx].metric = options.metric;
      if (options.metric_type) config.cycles[idx].metric_type = options.metric_type;
      if (options.surface) config.cycles[idx].surface = options.surface;
      if (options.direction) config.cycles[idx].direction = options.direction;
      if (options.enabled !== undefined) config.cycles[idx].enabled = options.enabled;
      if (options.window) config.cycles[idx].window = options.window;
      if (options.measurement) config.cycles[idx].measurement = options.measurement;
      if (options.loop_interval) config.cycles[idx].loop_interval = options.loop_interval;
      if (options.agent) config.cycles[idx].agent = options.agent;
      saveConfig(agentDir, config);
      return config.cycles;
    }

    case 'remove': {
      if (!options.name) {
        throw new Error('Cycle remove requires name');
      }
      const removeIdx = config.cycles.findIndex(c => c.name === options.name);
      if (removeIdx === -1) {
        throw new Error(`Cycle '${options.name}' not found`);
      }
      config.cycles.splice(removeIdx, 1);
      saveConfig(agentDir, config);
      return config.cycles;
    }

    case 'list': {
      // When an agent filter is supplied, return only that agent's cycles.
      // Omitting the agent returns the full list (back-compat for callers
      // that explicitly want a global view).
      if (options.agent) {
        return config.cycles.filter((c) => c.agent === options.agent);
      }
      return config.cycles;
    }

    default:
      throw new Error(`Unknown cycle action: ${action}`);
  }
}
