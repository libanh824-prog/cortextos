/**
 * tests/unit/cli/bus-list-approvals.test.ts — list-approvals --status flag.
 *
 * Covers the additive --status option added in fix/list-approvals-status-flag.
 * The flag was historically missing from the CLI; any cron passing it errored
 * out with "unknown option" exit 1 and silently broke approval monitoring. The
 * fix makes --status additive:
 *   - "pending" (the default) is a no-op — `listPendingApprovals` already
 *     returns pending requests only, so the success path is unchanged. This
 *     branch is covered by the existing tests/unit/bus/approval.test.ts
 *     against the `listPendingApprovals` function directly.
 *   - any other value surfaces a clear error rather than silently returning
 *     empty — that is the new guardrail, and the test below covers it.
 *
 * Test strategy mirrors tests/unit/cli/bus-crons.test.ts:
 *   - spy on console.error to capture the friendly error message
 *   - mock process.exit to throw so we can assert exit code 1
 *   - call busCommand.parseAsync directly with the desired argv
 *
 * The success branch ends up calling a runtime `require('../bus/approval.js')`
 * which vitest cannot resolve through ts-source, so we exercise the guardrail
 * (which short-circuits before the require) rather than the full pipeline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('bus list-approvals --status flag', () => {
  beforeEach(() => {
    // No global setup needed — the guardrail short-circuits before any I/O.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects --status with an unsupported value via clear error + exit 1', async () => {
    const { busCommand } = await import('../../../src/cli/bus');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code: number) => {
      throw new Error(`process.exit:${_code}`);
    }) as never);

    await expect(
      busCommand.parseAsync([
        'node',
        'bus',
        'list-approvals',
        '--status',
        'all',
        '--format',
        'json',
      ]),
    ).rejects.toThrow(/process\.exit:1/);

    const errOutput = errSpy.mock.calls.flat().join(' ');
    expect(errOutput).toContain('--status "all" is not supported');
    expect(errOutput).toContain('Only "pending" is supported');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects --status running (a plausible mis-paste from list-experiments) with the same clear error', async () => {
    const { busCommand } = await import('../../../src/cli/bus');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code: number) => {
      throw new Error(`process.exit:${_code}`);
    }) as never);

    await expect(
      busCommand.parseAsync([
        'node',
        'bus',
        'list-approvals',
        '--status',
        'running',
      ]),
    ).rejects.toThrow(/process\.exit:1/);

    const errOutput = errSpy.mock.calls.flat().join(' ');
    expect(errOutput).toContain('--status "running" is not supported');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
