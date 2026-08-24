import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installCommunityItem } from '../../../src/bus/catalog';

describe('installCommunityItem — install_path normalization (task_1776232775374_418)', () => {
  let frameworkRoot: string;
  let ctxRoot: string;

  beforeEach(() => {
    frameworkRoot = mkdtempSync(join(tmpdir(), 'catalog-fw-'));
    ctxRoot = mkdtempSync(join(tmpdir(), 'catalog-ctx-'));
    mkdirSync(join(frameworkRoot, 'community', 'skills', 'tasks'), { recursive: true });
    writeFileSync(join(frameworkRoot, 'community', 'skills', 'tasks', 'SKILL.md'), '# tasks');
  });

  afterEach(() => {
    rmSync(frameworkRoot, { recursive: true, force: true });
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  function writeCatalog(installPath: string) {
    const catalog = {
      version: '1.0.0',
      updated_at: '2026-04-15T00:00:00Z',
      items: [{
        name: 'tasks',
        description: 'test',
        author: 'test',
        type: 'skill',
        version: '1.0.0',
        tags: [],
        dependencies: [],
        install_path: installPath,
      }],
    };
    writeFileSync(join(frameworkRoot, 'community', 'catalog.json'), JSON.stringify(catalog));
  }

  it('shipped shape: install_path with leading "community/" prefix resolves correctly', () => {
    writeCatalog('community/skills/tasks');
    const agentDir = mkdtempSync(join(tmpdir(), 'catalog-agent-'));
    try {
      const r = installCommunityItem(frameworkRoot, ctxRoot, 'tasks', { agentDir });
      expect(r.status).toBe('installed');
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('submit shape: install_path as bare "skills/X" also resolves correctly', () => {
    writeCatalog('skills/tasks');
    const agentDir = mkdtempSync(join(tmpdir(), 'catalog-agent-'));
    try {
      const r = installCommunityItem(frameworkRoot, ctxRoot, 'tasks', { agentDir });
      expect(r.status).toBe('installed');
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('skill targets .claude/skills/<name>/ under agentDir — the Claude Code harness path', () => {
    writeCatalog('community/skills/tasks');
    const agentDir = mkdtempSync(join(tmpdir(), 'catalog-agent-'));
    try {
      const r = installCommunityItem(frameworkRoot, ctxRoot, 'tasks', { agentDir });
      expect(r.status).toBe('installed');
      expect((r as { target: string }).target).toBe(join(agentDir, '.claude', 'skills', 'tasks'));
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('path traversal still rejected after normalization', () => {
    writeCatalog('community/../../../etc/passwd');
    const r = installCommunityItem(frameworkRoot, ctxRoot, 'tasks');
    expect(r.status).toBe('error');
    expect(r.error).toContain('path traversal');
  });
});

// ── Presence-from-disk (task_1787598144541) ────────────────────────────────
// The old installed= read the community-install LEDGER — a narrower question
// than the "already installed" the doc promises. Template-shipped skills
// (never community-installed) reported false while present on disk and got
// re-recommended. installed now = disk presence at the exact install target.
import { itemTargetDir, browseCatalog as browse2 } from '../../../src/bus/catalog';
import { mkdirSync as mk2, writeFileSync as wf2 } from 'fs';

describe('browse installed = disk presence, ledger = provenance', () => {
  it('a template-shipped skill (on disk, NOT in ledger) reports installed=true, via_catalog=false', () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-presence-'));
    try {
      // catalog with one skill; empty ledger; skill present on disk
      mk2(join(root, 'community'), { recursive: true });
      wf2(join(root, 'community', 'catalog.json'), JSON.stringify({ items: [{ name: 'tasks', type: 'skill', description: 'x', tags: [] }] }));
      const agentDir = join(root, 'agent');
      mk2(join(agentDir, '.claude', 'skills', 'tasks'), { recursive: true });
      const res = browse2(root, join(root, 'ctx'), { agentDir });
      expect(res.status).toBe('ok');
      const item = res.items.find(i => i.name === 'tasks')!;
      expect(item.installed).toBe(true);        // present on disk
      expect((item as { via_catalog?: boolean }).via_catalog).toBe(false); // never community-installed
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a catalog skill absent from disk reports installed=false even if the ledger lists it', () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-absent-'));
    try {
      mk2(join(root, 'community'), { recursive: true });
      wf2(join(root, 'community', 'catalog.json'), JSON.stringify({ items: [{ name: 'ghost', type: 'skill', description: 'x', tags: [] }] }));
      mk2(join(root, 'ctx'), { recursive: true });
      wf2(join(root, 'ctx', '.installed-community.json'), JSON.stringify({ ghost: { version: '1', type: 'skill', installed_at: 'x', path: 'gone' } }));
      const res = browse2(root, join(root, 'ctx'), { agentDir: join(root, 'agent') });
      const item = res.items.find(i => i.name === 'ghost')!;
      expect(item.installed).toBe(false);        // ledger says yes, disk says no — disk wins
      expect((item as { via_catalog?: boolean }).via_catalog).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('itemTargetDir is the single source shared with install (skill/agent/org + unknown)', () => {
    expect(itemTargetDir('/fw', '/ag', 'skill', 's')).toBe('/ag/.claude/skills/s');
    expect(itemTargetDir('/fw', undefined, 'skill', 's')).toBe('/fw/.claude/skills/s');
    expect(itemTargetDir('/fw', '/ag', 'agent', 'a')).toBe('/fw/templates/personas/a');
    expect(itemTargetDir('/fw', '/ag', 'org', 'o')).toBe('/fw/templates/orgs/o');
    expect(itemTargetDir('/fw', '/ag', 'nope', 'x')).toBeNull();
  });
});
