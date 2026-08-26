#!/usr/bin/env bash
# resume-gap.sh — announce, once, that this guard was NOT RUNNING for a stretch.
#
# ★ WHY THIS EXISTS. On 2026-08-20T08:48Z the whole fleet went dark for 39.0h (an auth
# death; the box never rebooted). Every in-session guard stopped, and every one of them
# came back and reported HEALTHY. A guard cannot report a run it never made, so the
# silence left no trace anywhere except as a hole in the series — and a hole is read
# only by accident. This one surfaced six days later because a contaminated disk rate
# happened to surprise someone.
#
# THE PROPERTY IS COVERAGE, AND NOTHING ELSE SEES IT. Not the exit code (the guard is
# fine NOW). Not the sample count: 587 samples over 6.07d is 96.7/day against a nominal
# 96/day — the mean reads PERFECT with the 39h hole inside it. Not the span between
# endpoints. Only the distance from the newest row to now, checked BEFORE this run
# appends its own row, which is why callers must source and call this FIRST.
#
# SCOPE OF NON-COVERAGE, stated up front: this is the RECOVER-AND-REPORT half only. By
# the same law that motivates it — the thing that notices an agent is down cannot run
# inside the agent that died — this fires only IF the guard comes back. An agent that is
# down RIGHT NOW and STAYS down is invisible here, by construction. That case needs the
# out-of-band watcher; this is not a substitute for it and must not close its ticket.
#
# It RECORDS, it does not ALERT, and it does not change the exit code. A past gap is not
# a present finding: making it a finding would paint every ordinary fleet restart red and
# train the reader to skip it. Alerting on a LIVE outage is the out-of-band watcher's job.
#
# Usage, before the caller appends its own row:
#   . "${CTX_FRAMEWORK_ROOT:-/home/liban/cortextos}/bus/lib/resume-gap.sh"
#   resume_gap_announce "$SERIES" "$NOMINAL_S" "$STATE_DIR/resume-gap.<name>.json" "<label>"

# shellcheck source=/dev/null
[ -n "${JSONL_READ_SOURCED:-}" ] || . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jsonl-read.sh"

resume_gap_announce() {
  local series="$1" nominal_s="$2" statefile="$3" label="${4:-guard}"
  local threshold_s newest now_s gap_s gap_h last_seen

  # 3x nominal absorbs a slow run, a catch-up fire or a restart without crying outage.
  threshold_s=$(( nominal_s * 3 ))

  if [ ! -s "$series" ]; then
    # No series is not "no gap". It is no evidence, and it must not read as clean.
    echo "resume-gap[$label]: BLIND — series $series is missing or empty; coverage unknown"
    return 0
  fi

  # Through the tolerant reader: a single NUL row makes a bare grep/jq return NOTHING,
  # which here would read as "no rows, no gap" — silence produced by damage.
  newest=$(jsonl_read "$series" 2>/dev/null \
    | python3 -c '
import json,sys
best=""
for l in sys.stdin:
    try: d=json.loads(l)
    except Exception: continue
    t=d.get("ts","")
    if t>best: best=t
print(best)' 2>/dev/null)

  if [ -z "$newest" ]; then
    echo "resume-gap[$label]: BLIND — no readable timestamped row in $series; coverage unknown"
    return 0
  fi

  now_s=$(date -u +%s)
  gap_s=$(( now_s - $(date -u -d "$newest" +%s 2>/dev/null || echo "$now_s") ))
  [ "$gap_s" -le "$threshold_s" ] && return 0

  # Dedup on the gap's START — the last row before the dark stretch. That names the
  # EVENT, so one outage announces once however many times this is called afterwards.
  last_seen=""
  [ -s "$statefile" ] && last_seen=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("announced_after",""))' "$statefile" 2>/dev/null)
  [ "$last_seen" = "$newest" ] && return 0

  gap_h=$(python3 -c "print(f'{$gap_s/3600:.1f}')" 2>/dev/null || echo "?")
  printf '{"announced_after":"%s","gap_s":%s,"announced_at":"%s"}\n' \
    "$newest" "$gap_s" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$statefile" 2>/dev/null

  echo "resume-gap[$label]: NOT RUNNING for ${gap_h}h — newest row $newest, nominal cadence $((nominal_s/60))m. Nothing observed this stretch; it is excluded from rates, not measured."

  if command -v cortextos >/dev/null 2>&1; then
    cortextos bus log-event action resume_gap warn \
      --meta "{\"agent\":\"${CTX_AGENT_NAME:-analyst}\",\"guard\":\"$label\",\"gap_s\":$gap_s,\"after\":\"$newest\"}" \
      >/dev/null 2>&1 || true
  fi
  return 0
}
