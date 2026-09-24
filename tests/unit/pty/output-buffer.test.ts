import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs.appendFileSync so tests don't actually write to disk. We still
// need the real existsSync etc. for other imports in the module graph.
const appendFileSyncMock = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    appendFileSync: (...args: unknown[]) => appendFileSyncMock(...args),
  };
});

const { OutputBuffer, isShowingBypassScreen } = await import('../../../src/pty/output-buffer');

// Synthetic JWT used across tests. Has the canonical 3-segment shape and
// the `eyJ` header prefix so the redactor matches it. Length exceeds the
// {10,} per-segment minimum.
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXNlc3Npb24taWQifQ.abcdefghij_-abcdefghij';

beforeEach(() => {
  appendFileSyncMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OutputBuffer redaction', () => {
  it('single JWT in a single chunk: redacted in both disk log and in-memory buffer', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`session cookie: authjs.session-token=${FAKE_JWT}\n`);

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const writtenData = String(appendFileSyncMock.mock.calls[0][1]);
    expect(writtenData).toContain('[REDACTED_JWT]');
    expect(writtenData).not.toContain(FAKE_JWT);

    // In-memory ring buffer should also see the redacted form.
    const recent = buf.getRecent();
    expect(recent).toContain('[REDACTED_JWT]');
    expect(recent).not.toContain(FAKE_JWT);
  });

  it('multiple JWTs in one chunk: all redacted', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const another =
      'eyJxxxxxxxxxxxxxx.yyyyyyyyyyyyyyyy.zzzzzzzzzzzzzzzz__';
    buf.push(`a=${FAKE_JWT} b=${another} c=${FAKE_JWT}`);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    // Every JWT-shaped token replaced with the literal redaction marker.
    expect(written).not.toContain(FAKE_JWT);
    expect(written).not.toContain(another);
    const matches = (written.match(/\[REDACTED_JWT\]/g) || []).length;
    expect(matches).toBe(3);
  });

  it('non-JWT PTY data passes through unchanged (regression guard)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // TUI ANSI escapes, regular stdout, plausible-but-too-short alphanum.
    const tuiOutput =
      '\x1b[38;5;114m●\x1b[39m Running tests... version v1.2.3 hash=abc.def.ghi\n';
    buf.push(tuiOutput);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toBe(tuiOutput); // byte-for-byte identical
    expect(written).not.toContain('[REDACTED_JWT]');
  });

  it('bootstrap detection still works after redaction', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // Claude Code's permissions status bar line — contains "permissions"
    // which isBootstrapped() searches for. No JWT in this chunk — the
    // test guards that redaction does not accidentally break the ring
    // buffer's search path.
    buf.push('\x1b[2m ? \x1b[0mfor shortcuts                  permissions: bypass\n');
    expect(buf.isBootstrapped()).toBe(true);
  });

  it('chunk-boundary edge case is NOT redacted (documents the known limitation)', () => {
    // Split a JWT across two push() calls. Neither chunk matches the
    // regex on its own — the redactor is stateless and chunk-local. This
    // test INTENTIONALLY asserts the un-redacted behavior so that any
    // future refactor adding buffer-aware redaction has to be an
    // explicit decision (the test fails and forces a re-review).
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const half1 = FAKE_JWT.slice(0, 40);
    const half2 = FAKE_JWT.slice(40);
    buf.push(`prefix ${half1}`);
    buf.push(`${half2} suffix`);

    const firstWrite = String(appendFileSyncMock.mock.calls[0][1]);
    const secondWrite = String(appendFileSyncMock.mock.calls[1][1]);
    // Each half survives because neither chunk is a complete JWT shape.
    expect(firstWrite).toContain(half1);
    expect(secondWrite).toContain(half2);
    // Neither chunk contains the redaction marker.
    expect(firstWrite).not.toContain('[REDACTED_JWT]');
    expect(secondWrite).not.toContain('[REDACTED_JWT]');
  });

  it('short alphanumeric that resembles a truncated JWT is NOT redacted (length guard)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // "eyJab.x.y" has the right header prefix and the right shape but
    // segments are all too short — the {10,} length qualifier must
    // prevent this from matching.
    const shortTokenLike = 'eyJab.x.y';
    buf.push(`debug_token=${shortTokenLike} ok=true\n`);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toContain(shortTokenLike);
    expect(written).not.toContain('[REDACTED_JWT]');
  });
});

describe('OutputBuffer bootstrap guards — Bypass Permissions screen', () => {
  // Realistic fixtures. The status bar is the REAL one from the suite above:
  // it literally reads "permissions: bypass", which is why the guard below must
  // key on three co-occurring tokens — anything keyed on "bypass" alone would
  // suppress bootstrap for every healthy agent.
  const STATUS_BAR =
    '\x1b[2m ? \x1b[0mfor shortcuts                  permissions: bypass\n';
  // Hypothetical future TUI that renders the screen's heading in LOWERCASE.
  // That casing is the whole hazard: it satisfies the bootstrap match.
  const BYPASS_SCREEN_LOWERCASE =
    'WARNING: Claude Code running in bypass permissions mode\n' +
    '\x1b[1mIn bypass permissions mode, Claude Code will not ask for approval.\x1b[0m\n' +
    '  1. No, exit\n' +
    '  2. Yes, I accept\n';
  // Today's screen: title-case heading, so the bootstrap pattern never matches it.
  const BYPASS_SCREEN_TITLECASE =
    'WARNING: Bypass Permissions mode\n  1. No, exit\n  2. Yes, I accept\n';

  it('positive control: the real status bar reads as bootstrapped', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(STATUS_BAR);
    expect(buf.isBootstrapped()).toBe(true);
  });

  it('a lowercase bypass screen does NOT read as bootstrapped (the closed gap)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(BYPASS_SCREEN_LOWERCASE);
    // Pre-fix this returned TRUE: "bypass permissions mode" contains the
    // bootstrap pattern, so the auto-accept poll stops before sending Down+Enter
    // and the awaitingConfirmation backstop stays silent — a wedge reported as
    // "running". This assertion is the mutation check: delete the guard in
    // output-buffer.ts and it fails.
    expect(buf.isBootstrapped()).toBe(false);
  });

  it("today's title-case screen is not bootstrapped either", () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(BYPASS_SCREEN_TITLECASE);
    expect(buf.isBootstrapped()).toBe(false);
  });

  it('agent output merely DISCUSSING bypass+accept stays bootstrapped', () => {
    // The false-positive direction, which is the harmful one: suppressing
    // bootstrap on a live agent stops message injection entirely. Two tokens
    // are reachable in ordinary text; the screen's numbered default is not.
    // Evaluated in ONE call with nothing bootstrapped beforehand, so the latch
    // cannot be what saves it — this asserts the THRESHOLD. Loosen the guard to
    // two tokens and this fails.
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(STATUS_BAR);
    buf.push('I had to bypass the check before the reviewer would accept the PR.\n');
    expect(buf.isBootstrapped()).toBe(true);
  });

  it('pre-boot output discussing bypass+accept does not block the status bar', () => {
    // Same threshold assertion with the discussion arriving FIRST, so the very
    // first isBootstrapped() call sees permissions + bypass + accept together.
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push('Reviewer note: we bypass the gate only when L and Ali both accept.\n');
    buf.push(STATUS_BAR);
    expect(buf.isBootstrapped()).toBe(true);
  });

  it('once bootstrapped, a bypass-shaped screen cannot un-bootstrap the session', () => {
    // The latch. Bounds any future false positive to the pre-boot window.
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(STATUS_BAR);
    expect(buf.isBootstrapped()).toBe(true);
    buf.push(BYPASS_SCREEN_LOWERCASE);
    expect(buf.isBootstrapped()).toBe(true);
  });

  it('once bootstrapped, trust-shaped output cannot un-bootstrap the session', () => {
    // Same latch, applied to the pre-existing trust guard — which had the same
    // latent exposure to live output containing "trust".
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(STATUS_BAR);
    expect(buf.isBootstrapped()).toBe(true);
    buf.push('Do you trust the upstream maintainer?\n');
    expect(buf.isBootstrapped()).toBe(true);
  });

  it('the guard is scoped to the permissions pattern — Hermes is untouched', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log', '❯');
    buf.push(BYPASS_SCREEN_LOWERCASE);
    expect(buf.isBootstrapped()).toBe(false); // no prompt char yet
    buf.push('❯ ');
    expect(buf.isBootstrapped()).toBe(true);  // prompt char wins regardless
  });
});

describe('isShowingBypassScreen threshold', () => {
  it('requires all three co-occurring tokens', () => {
    expect(isShowingBypassScreen('bypass permissions mode')).toBe(false);
    expect(isShowingBypassScreen('bypass ... I accept')).toBe(false);
    expect(isShowingBypassScreen('1. No, exit  2. Yes, I accept')).toBe(false);
    expect(isShowingBypassScreen('Bypass Permissions\n1. No, exit\n2. Yes, I accept')).toBe(true);
  });

  it('is case- and spacing-insensitive on the conjunction', () => {
    expect(isShowingBypassScreen('BYPASS / ACCEPT / NO,EXIT')).toBe(true);
    expect(isShowingBypassScreen('bypass accept no,   exit')).toBe(true);
  });
});
