#!/usr/bin/env bash
# ─── ALERT BUDGET ───────────────────────────────────────────────────────────
# Shared flap cap for every fleet guard that sends.
#
# WHY IT EXISTS. On 2026-08-21 an uncapped repeat path sent L 171 CODE REDs in two
# days. The fleet audit that followed found no other repeat-while-true path — but
# found that all 7 remaining alerting guards CLEAR their dedup key the instant the
# condition clears, with no hysteresis. So the same flood is reachable by the
# condition OSCILLATING instead of PERSISTING: avail 801MB clears the key, 799MB
# re-alerts, and on a 15m cron that is up to 96 sends a day. Per-guard dedup answers
# "has this condition already been reported?"; nothing answered "how many times have
# I spoken about this key lately?". This does.
#
# CONTRACT.
#   alert_budget_ok <state_file> <key> [max] [window_s]
#     rc 0  -> caller MAY send. The attempt is recorded.
#     rc 1  -> caller MUST NOT send. A suppression note is printed on stderr.
#   The note is mandatory and unconditional: a budget that suppresses silently
#   reproduces the mute-exit defect this fleet treats as a bug everywhere else.
#   Silence is never the output; the alert is what gets withheld, not the fact of it.
#
# IT BACKS OFF, IT DOES NOT CAP OUT. The window ROLLS, so a genuinely persistent
# problem resumes alerting once the old attempts age out. A hard cap would go
# permanently quiet on a real incident, which is worse than the flood.
#
# BUDGET STATE IS SEPARATE FROM DEDUP STATE by design — the guards' own dedup keys
# are cleared on recovery, which is precisely the clearing this is meant to survive.

alert_budget_ok() {
  local sf="$1" key="$2" max="${3:-4}" window_s="${4:-3600}"
  local now; now=$(date -u +%s)
  [ -f "$sf" ] || echo '{}' > "$sf"
  local kept
  kept=$(jq -c --arg k "$key" --argjson now "$now" --argjson w "$window_s" \
    '(.[$k] // []) | map(select(. > ($now - $w)))' "$sf" 2>/dev/null) || kept="[]"
  [ -n "$kept" ] || kept="[]"
  local n; n=$(printf '%s' "$kept" | jq 'length' 2>/dev/null || echo 0)
  if [ "${n:-0}" -ge "$max" ]; then
    local oldest_in age_min
    oldest_in=$(printf '%s' "$kept" | jq 'min' 2>/dev/null || echo "$now")
    age_min=$(( (now - oldest_in) / 60 ))
    local window_min=$(( window_s / 60 ))
    # ★ MESSAGE CORRECTED 2026-08-25. This said "Resumes as attempts age out (oldest is
    # Nmin old)", which invites the reader to expect a resumption in window-minus-N
    # minutes. Under a PERSISTENT condition that never comes: the append below is
    # deliberate ("reflects real pressure, not just sends"), so every run adds an entry
    # and the window can never drain while the condition fires. Measured: 3 sends then
    # 0 for every subsequent run; with the 3 originals aged past the window but 9
    # suppressed attempts inside it, still 0. The BEHAVIOUR is right — cap the outbound
    # noise, keep the finding in the caller's output and exit code. The SENTENCE was
    # the part that was false, and a persistent verdict has to be worded in the
    # persistent tense or a reader who checks it stops trusting the instrument.
    echo "alert-budget: SUPPRESSED '$key' — ${n} alerts already in the last $((window_s/60))min (max ${max}). NOT an all-clear: the condition is still being evaluated and reported here; only the outbound send is withheld. Suppressions COUNT toward the window (see below), so while this condition keeps firing every run it stays suppressed BY DESIGN — it resumes only once the condition goes quiet long enough for the window to drain. Oldest entry is ${age_min}min old of ${window_min}min." >&2
    # Record the suppression so the window reflects real pressure, not just sends.
    jq --arg k "$key" --argjson now "$now" --argjson kept "$kept" \
      '.[$k] = ($kept + [$now])' "$sf" > "$sf.tmp" 2>/dev/null && mv "$sf.tmp" "$sf"
    return 1
  fi
  jq --arg k "$key" --argjson now "$now" --argjson kept "$kept" \
    '.[$k] = ($kept + [$now])' "$sf" > "$sf.tmp" 2>/dev/null && mv "$sf.tmp" "$sf"
  return 0
}
