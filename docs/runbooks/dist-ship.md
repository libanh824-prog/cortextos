# Dist-batch ship runbook (task_1787627302175_19947412)

One `npm run build` swaps the fleet-shared `dist/` — every agent's CLI at
once (SPOF moment). This runbook is the motion + rollback the ship task
points at.

## Pre-flight
1. `npx tsc --noEmit` — clean.
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

## Live-verify (all six, per commit)
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

## Rollback (any live-verify failure)
5. `rm -rf dist && mv dist.pre-<date> dist` — restores the exact prior
   fleet CLI without a rebuild. Then file the failure; do NOT iterate fixes
   against the live dist. The snapshot restore is the whole plan: a red
   check with no rollback is a fleet outage with extra steps.
6. Keep the snapshot until the NEXT successful ship; then delete.
