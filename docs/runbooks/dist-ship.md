# Dist-batch ship runbook (task_1787627302175_19947412)

One `npm run build` swaps the fleet-shared `dist/` — every agent's CLI at
once (SPOF moment). This runbook is the motion + rollback the ship task
points at.

## Pre-flight
0. **DERIVE the batch manifest — never remember it.** The authoritative
   list is `git log --oneline $(cat dist/BUILT_FROM 2>/dev/null || echo e1757fd)..HEAD`.
   A count or commit list written in a task description is a REMEMBERED
   figure and it has already rotted once ("six" was seven by the next
   morning). `dist/BUILT_FROM` is stamped by step 4b below; until the first
   stamped ship, the base is e1757fd — verified 2026-08-25 as the commit
   live dist is built from (proven by the accidental-build restore:
   negative control `get-task` unknown + positive control `list-crons`).
1. `npx tsc --noEmit` — clean. (NEVER `npm run build` for checks — it
   swaps the live fleet CLI; that is the ship step, nothing else.)
2. `npm test` — gate is **no NEW failures vs baseline**, not zero: 37
   failures pre-exist independent of the batch (A/B-proven 2026-08-23:
   hooks / execution-log-pagination / upgrade-cron-teaching suites,
   identical counts with the batch stashed vs applied). Record the count.
3. **Snapshot the running dist**: `cp -a dist dist.pre-$(date -u +%Y%m%d)`
   — this is the rollback artifact; do not skip it because the build
   "should" work.

## Ship
4. `npm run build` (tsup → dist/). CLI invocations pick the new code up
   immediately; running daemons keep their loaded code (none of the current
   batch touches daemon runtime — re-check this claim for any future batch).
4b. **Stamp the build**: `git rev-parse HEAD > dist/BUILT_FROM` — this is
   what makes step 0's manifest derivable next time instead of remembered.

## Live-verify (one check PER MANIFEST COMMIT — walk the step-0 list, not
this section's examples; a commit with no check below needs one written
before the ship, not skipped)
- d24afc0/07146b4: `cortextos bus gather-context --agent analyst` reads
  keeps 1 / discards 1 / keep_rate 0.5 / basis n=2, excluded 47.
- c2f329e: send a bus message; confirm the new history line is complete and
  `jq -c . logs/message-history.jsonl | wc -l` grew by exactly 1 vs
  jsonl_read (historical tear still differs by design — compare GROWTH).
- 5d9b3a8: run the loop-detector hook once via its stdin protocol against a
  temp state dir; confirm lifetime fields + event row appear.
- dee5be1: `cortextos bus browse-catalog` from an agent dir shows
  template-shipped skills installed=true with via_catalog=false.
- 0298641: docs only — no runtime check.
- 51a1ab2: `cortextos bus get-task <any real id>` prints full JSON and the
  task file's mtime is unchanged; a truncated id exits 1 saying TRUNCATED
  with the full-id candidates.
- 96f330c: on the shipping agent's OWN cron-state
  (`~/.cortextos/<inst>/state/<agent>/cron-state.json`), read the
  `interval` of a cron that has one (dev: `heartbeat-tick` = 30m), run the
  flag-less `cortextos bus update-cron-fire heartbeat-tick`, read again:
  `interval` is UNCHANGED (old dist: erased → the gap monitors go blind on
  that cron). Positive control: `--interval 30m` still writes it. Then
  confirm the file is byte-parseable (`jq . cron-state.json >/dev/null`) —
  the atomic-write half. The extra mark is harmless (a real fire time).
- 5d2cde3: src delta is ONE comment line in `src/bus/message.ts` (proven:
  `git show --format= 5d2cde3 -- src | grep '^[-+]' | grep -v '^[-+][-+]'`
  shows only the comment); no runtime check. Its bus/lib/*.sh + TOOLS.md
  parts are read from disk and were live at commit time.
- PR #1 (feat/upstream-tier-a-pr1 — a15baad fdfaa78 28500e7 af58ef8 756b931
  f1b8aad + 7e79e12 comment): CLI half right after the build —
  `cortextos bus list-tasks` shows full 27-char ids; `cortextos bus
  complete-task bogus-id` exits 1 with ONE stderr line, no stack; `cortextos
  status` renders with a model column. DAEMON half only after
  `pm2 restart cortextos-daemon` (dist/daemon.js keeps loaded code until
  then — this batch is the FIRST that touches daemon runtime; all 4 agents
  soft-restart with --continue, no L ping per banked rule): `cortextos
  status` shows no `unhealthy*` on a healthy agent; hand-edit a prompt in a
  test cron in crons.json → the next fire carries the new text within one
  tick with NO IPC poke (af58ef8); an inbound Telegram to an idle agent does
  NOT advance its heartbeat.json last_heartbeat while its own `bus log-event`
  does (28500e7). Rollback for this batch = restore snapshot AND restart the
  daemon again, so the old daemon code is what runs.

## Rollback (any live-verify failure)
5. `rm -rf dist && mv dist.pre-<date> dist` — restores the exact prior
   fleet CLI without a rebuild. Then file the failure; do NOT iterate fixes
   against the live dist. The snapshot restore is the whole plan: a red
   check with no rollback is a fleet outage with extra steps.
6. Keep the snapshot until the NEXT successful ship; then delete.

## Riders for L review at ship time (flagged, NOT built — chief 2026-08-25)
- Prebuild-snapshot npm hook: `prebuild` script snapshots dist
  automatically, making an accidental build recoverable by mechanism.
- Build-to-staging (impossible-by-construction): `npm run build` writes a
  staging dir; only this runbook's ship step swaps it into live `dist/`.
  Bigger change — gauge appetite, do not fold in silently.
