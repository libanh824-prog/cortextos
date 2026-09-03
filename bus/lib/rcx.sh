#!/usr/bin/env bash
# rcx — run a command, bound its output, and return the status YOU NAMED.
#
# WHY THIS EXISTS
# ---------------
# Twice the wrong exit code was read off a pipeline, and both times the number
# that came back was plausible:
#
#   1. `cortextos bus get-task ... | head` with $? read afterwards. That is HEAD's
#      status, always 0. get-task actually exits 1 — correctly loud — and I
#      recorded it as a fail-silent trap it never was. PIPESTATUS[0] was 1.
#   2. `git diff --cached | grep -E '<pii>' | head -10 || echo "none found"`
#      immediately before a commit. The || reads HEAD's status, which is 0
#      whether or not grep matched, so the "none found" branch could NEVER fire
#      and a real match would have scrolled past unnoticed. The rc-reading defect
#      was inside the pre-commit review gate itself.
#
# THE RULE THOSE PRODUCED: an output-bounding pipe and an exit-code reading
# cannot share a command line. The shell picks the LAST command's status
# silently, and silently is the whole problem.
#
# SO THIS TOOL MAKES THE CHOICE EXPLICIT AND MANDATORY. There are two different
# questions and they have different answers:
#
#   --status cmd     did the COMMAND succeed?        -> exits with the command's rc
#   --status match   did the PATTERN appear?         -> exits 0 match / 1 no-match
#
# --status is REQUIRED. Omitting it is refused (rc 2), never defaulted, because a
# default is the shell's silent pick wearing a different hat. Bounding happens
# AFTER the status is captured, from a file, so no pipeline ever sits on the
# rc-bearing command.
#
# ★ HONEST RUNG: THIS IS LEVEL 3, NOT LEVEL 2. It makes the correct form the
# easier one; it does NOT make the wrong form unrepresentable, because nothing
# stops anyone typing a raw pipeline instead. A helper you must remember to reach
# for is exactly a rule you must remember. What makes it bite is being named as
# the DEFAULT in the carriers that generate the commands — HEARTBEAT.md and the
# cron prompts — the same wiring that made bus/lib/rowfields.py bite. Do not file
# this as level 2; an overstated rung is how a habit gets recorded as solved.
#
# USAGE
#   rcx.sh --status cmd   [--head N|--tail N] -- <command> [args...]
#   rcx.sh --status match --grep PATTERN [-F] [--head N] -- <command> [args...]
#
# Every run prints a trailer naming which status it returned, so the output
# cannot be read as the other question's answer.

set -uo pipefail

die() { printf 'rcx: %s\n' "$1" >&2; exit 2; }

STATUS=""; HEAD=""; TAIL=""; PATTERN=""; FIXED=""; QUIET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --status) [ $# -ge 2 ] || die "--status needs a value"; STATUS="$2"; shift 2 ;;
    --head)   [ $# -ge 2 ] || die "--head needs a value";   HEAD="$2";   shift 2 ;;
    --tail)   [ $# -ge 2 ] || die "--tail needs a value";   TAIL="$2";   shift 2 ;;
    --grep)   [ $# -ge 2 ] || die "--grep needs a value";   PATTERN="$2"; shift 2 ;;
    -F|--fixed) FIXED=1; shift ;;
    --quiet)  QUIET=1; shift ;;
    --)       shift; break ;;
    -h|--help) sed -n '1,50p' "$0"; exit 0 ;;
    *)        die "unknown option '$1' (did you forget -- before the command?)" ;;
  esac
done

[ $# -gt 0 ] || die "no command after --"
case "$STATUS" in
  cmd|match) ;;
  "")  die "--status is REQUIRED: 'cmd' (did the command succeed?) or 'match' (did the pattern appear?). There is no default, because a silent default is the defect this tool exists to remove." ;;
  *)   die "--status must be 'cmd' or 'match', got '$STATUS'" ;;
esac
[ "$STATUS" = match ] && [ -z "$PATTERN" ] && die "--status match requires --grep PATTERN"

OUT=$(mktemp) || die "mktemp failed"
trap 'rm -f "$OUT"' EXIT INT TERM HUP

# ── THE WHOLE POINT: the command runs with NO pipeline on it, so $? is its own.
"$@" > "$OUT" 2>&1
cmd_rc=$?

match_rc=1
if [ -n "$PATTERN" ]; then
  # grep reads the FILE, not a stream, so bounding below cannot change what it saw.
  if [ -n "$FIXED" ]; then grep -qF -- "$PATTERN" "$OUT"; else grep -qE -- "$PATTERN" "$OUT"; fi
  match_rc=$?
fi

if [ -z "$QUIET" ]; then
  if   [ -n "$HEAD" ]; then head -n "$HEAD" "$OUT"
  elif [ -n "$TAIL" ]; then tail -n "$TAIL" "$OUT"
  else cat "$OUT"; fi
fi

lines=$(wc -l < "$OUT")
if [ "$STATUS" = cmd ]; then
  [ -z "$QUIET" ] && printf 'rcx: returning COMMAND status %d (%d line(s) of output; bounding did not touch it)\n' "$cmd_rc" "$lines" >&2
  exit "$cmd_rc"
else
  [ -z "$QUIET" ] && printf 'rcx: returning MATCH status %d (%s; command itself exited %d, %d line(s))\n' \
    "$match_rc" "$([ "$match_rc" -eq 0 ] && echo 'pattern FOUND' || echo 'pattern NOT found')" "$cmd_rc" "$lines" >&2
  exit "$match_rc"
fi
