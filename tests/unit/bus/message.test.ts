import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox, ackInbox, InboxLockUnavailableError } from '../../../src/bus/message';
import { acquireLock, releaseLock } from '../../../src/utils/lock';
import { resolvePaths } from '../../../src/utils/paths';
import type { BusPaths } from '../../../src/types';

describe('Message Bus', () => {
  let testDir: string;
  let senderPaths: BusPaths;
  let receiverPaths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-bus-test-'));
    // Override ctxRoot to use temp directory
    senderPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'sender'),
      inflight: join(testDir, 'inflight', 'sender'),
      processed: join(testDir, 'processed', 'sender'),
      logDir: join(testDir, 'logs', 'sender'),
      stateDir: join(testDir, 'state', 'sender'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    receiverPaths = {
      ...senderPaths,
      inbox: join(testDir, 'inbox', 'receiver'),
      inflight: join(testDir, 'inflight', 'receiver'),
      processed: join(testDir, 'processed', 'receiver'),
      logDir: join(testDir, 'logs', 'receiver'),
      stateDir: join(testDir, 'state', 'receiver'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('sendMessage', () => {
    it('creates a JSON file in receiver inbox', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'Hello');
      expect(msgId).toBeTruthy();

      const receiverInbox = join(testDir, 'inbox', 'receiver');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);

      // Verify filename format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
      expect(files[0]).toMatch(/^2-\d+-from-sender-[a-z0-9]{5}\.json$/);
    });

    it('produces JSON matching bash format', () => {
      sendMessage(senderPaths, 'paul', 'boris', 'high', 'Build the page');

      const receiverInbox = join(testDir, 'inbox', 'boris');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      const content = JSON.parse(readFileSync(join(receiverInbox, files[0]), 'utf-8'));

      // Verify all fields match bash send-message.sh format
      expect(content).toHaveProperty('id');
      expect(content).toHaveProperty('from', 'paul');
      expect(content).toHaveProperty('to', 'boris');
      expect(content).toHaveProperty('priority', 'high');
      expect(content).toHaveProperty('timestamp');
      expect(content).toHaveProperty('text', 'Build the page');
      expect(content).toHaveProperty('reply_to', null);

      // Verify filename has priority 1 (high)
      expect(files[0]).toMatch(/^1-/);
    });

    it('encodes priority correctly in filename', () => {
      sendMessage(senderPaths, 'a', 'b', 'urgent', 'test');
      sendMessage(senderPaths, 'a', 'b', 'high', 'test');
      sendMessage(senderPaths, 'a', 'b', 'normal', 'test');
      sendMessage(senderPaths, 'a', 'b', 'low', 'test');

      const inbox = join(testDir, 'inbox', 'b');
      const files = readdirSync(inbox).filter(f => f.endsWith('.json')).sort();

      expect(files[0]).toMatch(/^0-/); // urgent
      expect(files[1]).toMatch(/^1-/); // high
      expect(files[2]).toMatch(/^2-/); // normal
      expect(files[3]).toMatch(/^3-/); // low
    });

    it('rejects invalid agent names', () => {
      expect(() =>
        sendMessage(senderPaths, '../bad', 'good', 'normal', 'test')
      ).toThrow();
    });

    it('history log line-integrity: every append is one complete parseable line, incl. >4KB records (task_1787489896030)', () => {
      // The Jul 9 2026 tear left NUL bytes + a merged line that truncated
      // every jq reader at 40% of the file. Contract under test: N sends
      // produce exactly N lines, each independently parseable — the
      // jq-equivalence property the fix must preserve. Includes a record
      // well past 4096 bytes (the size class the split-write hypothesis
      // worried about; ruled out forensically, pinned here anyway).
      const big = 'x'.repeat(6000);
      for (let i = 0; i < 5; i++) {
        sendMessage(senderPaths, 'sender', 'receiver', 'normal', i === 2 ? big : `msg-${i}`);
      }
      const logPath = join(testDir, 'logs', 'message-history.jsonl');
      const raw = readFileSync(logPath, 'utf-8');
      expect(raw.includes('\u0000')).toBe(false);
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(5);
      lines.forEach((l, i) => {
        const rec = JSON.parse(l); // throws = fail
        expect(rec.from).toBe('sender');
        if (i === 2) expect(rec.text.length).toBe(6000);
      });
    });

    it('appends each delivered message as a JSONL line to logs/message-history.jsonl', () => {
      // Backs task C1 — the dashboard /api/comms/* endpoints read
      // message-history.jsonl as their primary source. Without this
      // write the file never exists and every page load falls back
      // to scanning processed/{agent}/ file-by-file.
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'one');
      sendMessage(senderPaths, 'receiver', 'sender', 'high', 'two', '<reply-id>');

      const logPath = join(testDir, 'logs', 'message-history.jsonl');
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]);
      expect(first).toMatchObject({
        from: 'sender',
        to: 'receiver',
        priority: 'normal',
        text: 'one',
        reply_to: null,
      });
      expect(first.id).toBeTruthy();
      expect(first.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const second = JSON.parse(lines[1]);
      expect(second).toMatchObject({
        from: 'receiver',
        to: 'sender',
        priority: 'high',
        text: 'two',
        reply_to: '<reply-id>',
      });
    });
  });

  describe('checkInbox', () => {
    it('returns empty array for empty inbox', () => {
      const messages = checkInbox(receiverPaths);
      expect(messages).toEqual([]);
    });

    it('returns messages sorted by priority', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'low', 'low priority');
      sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'urgent');
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'normal');

      const messages = checkInbox(receiverPaths);
      expect(messages.length).toBe(3);
      expect(messages[0].priority).toBe('urgent');
      expect(messages[1].priority).toBe('normal');
      expect(messages[2].priority).toBe('low');
    });

    it('moves messages to inflight', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths);

      const inboxFiles = readdirSync(receiverPaths.inbox).filter(f => f.endsWith('.json'));
      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));

      expect(inboxFiles.length).toBe(0);
      expect(inflightFiles.length).toBe(1);
    });

    it('throws InboxLockUnavailableError when the inbox lock is held — never a fake empty read', () => {
      // A held (or permanently orphaned) lock must surface as a failure the
      // caller can retry — returning [] here is indistinguishable from a
      // successfully-read empty inbox and silently black-holes every message.
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'must not vanish');
      const held = acquireLock(receiverPaths.inbox);
      expect(held).not.toBe(false);
      try {
        expect(() => checkInbox(receiverPaths)).toThrow(InboxLockUnavailableError);
        expect(() => checkInbox(receiverPaths)).toThrow(/Inbox lock unavailable/);
      } finally {
        if (held) releaseLock(held);
      }
      // Once the lock is free the message is still there and delivers — nothing
      // was consumed or lost during the locked window.
      const messages = checkInbox(receiverPaths);
      expect(messages.length).toBe(1);
      expect(messages[0].text).toBe('must not vanish');
    });
  });

  describe('ackInbox', () => {
    it('moves message from inflight to processed', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths); // moves to inflight

      ackInbox(receiverPaths, msgId);

      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));
      const processedFiles = readdirSync(receiverPaths.processed).filter(f => f.endsWith('.json'));

      expect(inflightFiles.length).toBe(0);
      expect(processedFiles.length).toBe(1);
    });
  });
});
