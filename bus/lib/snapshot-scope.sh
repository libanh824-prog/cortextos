#!/usr/bin/env bash
# snapshot-scope.sh — THE SINGLE DEFINITION of what the workspace snapshot protects.
#
# ★ WHY THIS EXISTS (2026-08-27). make-workspace-snapshot.sh tars `find orgs/command` across
# ALL FOUR agents. The coverage check that decided whether the snapshot was complete lived as
# shell embedded in a CRON PROMPT and searched `agents/analyst` with three extensions and no
# exclusions. So the checker's population was roughly a QUARTER of the archiver's, in both
# directions at once — too narrow (missing *.jsonl, *.mjs, .gitkeep) and too broad (not
# excluding *.env, incoming/, reference/).
#
# Measured the day it was found: the check reported 0 newer — CLEAN — while the snapshot's own
# scope had a file newer than the archive (agents/chief/memory/2026-08-27.md). A green whose
# population is smaller than the claim it licenses.
#
# TWO CONSUMERS, ONE DEFINITION, so they cannot drift apart:
#   make-workspace-snapshot.sh  — builds the archive from this predicate
#   check-snapshot-coverage.sh  — asks what is NEWER than the archive, using the SAME predicate
# Editing the population here changes BOTH. That is the point: a second hand-written copy is
# exactly the defect this file removes, so never re-type these globs at a call site.

SNAPSHOT_SRC_ROOT="${CTX_FRAMEWORK_ROOT:-/home/liban/cortextos}"
SNAPSHOT_SUBTREE="orgs/command"

# Allowlist by EXTENSION plus three path exclusions. Anything not named here is out of the
# backup by construction, which is why a .env can never sneak in.
SNAPSHOT_FIND_PREDICATE=(
  \( -name '*.md' -o -name '*.sh' -o -name '*.json' -o -name '*.jsonl'
     -o -name '*.mjs' -o -name '.gitkeep' \)
  ! -name '*.env' ! -path '*/incoming/*' ! -path '*/reference/*'
)
