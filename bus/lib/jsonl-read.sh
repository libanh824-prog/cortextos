#!/usr/bin/env bash
# jsonl-read.sh — a NUL/corruption-tolerant jsonl reader that ANNOUNCES what it skipped.
#
# ★ WHY THIS EXISTS (2026-08-23). message-history.jsonl line 2443 is 1421 bytes of NUL —
# a torn write from a crash mid-append. `jq` ABORTS THE STREAM at that line and exits, so
# it returned 2442 of 6045 rows: THE FIRST 40% OF THE FILE AS IF IT WERE THE WHOLE FILE,
# with no error unless the caller checks $? — which nobody does in `jq ... f | sort | uniq -c`.
# It nearly walked me into an absence claim ("there is no 2026-07-22 cluster") drawn from
# 40% of the evidence, and the under-report direction is toward "nothing there", which is
# the worst direction an absence claim can fail in.
#
# ★ AND THE COROLLARY, which is the load-bearing half (chief): A TOLERANT READER THAT
# SILENTLY SKIPS IS THE SAME DEFECT ONE LAYER UP — it just moves the truncation into the
# reader. So this NEVER skips quietly. Every unparseable row is counted and announced on
# stderr, with line numbers, and the caller can make it fatal.
#
# Usage:  jsonl_read <file>            -> valid JSON objects on stdout, one per line
#                                          skip report on stderr, always, if any
#         JSONL_STRICT=1 jsonl_read f  -> also exit 1 when anything was skipped
# Exit:   0 clean or tolerated, 1 skipped-and-strict, 2 unreadable.
jsonl_read() {
  local f="$1"
  [ -r "$f" ] || { echo "jsonl-read: BLIND — cannot read $f" >&2; return 2; }
  python3 - "$f" <<'PY'
import json, os, sys
path = sys.argv[1]
bad = []
n = 0
with open(path, 'rb') as fh:
    for i, raw in enumerate(fh, 1):
        # ★ A LINE THAT IS EMPTY ONLY AFTER STRIPPING NULs IS CORRUPTION, NOT A BLANK
        # LINE. The first cut stripped \x00 and then hit `if not s: continue`, so the
        # 1421-NUL torn write was skipped SILENTLY — I built the exact silent-skip defect
        # this reader exists to prevent, into the reader, while writing the comment
        # warning about it. Caught by the positive control: the known-bad file announced
        # NOTHING. Distinguish the two cases before deciding anything.
        text = raw.decode('utf-8', 'replace').strip('\r\n')
        had_nul = '\x00' in text
        s = text.strip('\x00').strip()
        if not s:
            if had_nul or text.strip():
                bad.append(i)      # corruption that collapsed to empty — NOT a blank line
            continue
        try:
            json.loads(s)
        except Exception:
            bad.append(i)
            continue
        n += 1
        try:
            sys.stdout.write(s + '\n')
        except BrokenPipeError:
            # ★ THE CONSUMER LEFT EARLY, AND THAT IS NOT AN ERROR HERE (2026-08-26).
            # `jsonl_read f | head -1` or any early-exiting consumer closes the pipe
            # while this loop is still writing, and Python raised BrokenPipeError —
            # a TRACEBACK on stderr and exit 1 from the fleet's tolerant reader. It
            # surfaced through check-disk-space, which printed a traceback and still
            # exited 0. Reproduced 5/5 with `jsonl_read series | head -1`.
            # Same family as the SIGPIPE-under-pipefail bug found in check-disk-space
            # the same morning: a producer dying because its consumer stopped
            # listening, once in bash and once in Python.
            # ★ AND DO NOT PRINT THE SKIP REPORT AFTERWARDS. The read is TRUNCATED,
            # so "SKIPPED 0 of N" would be a completeness claim over a file this run
            # never finished reading. Say nothing and leave; the consumer asked to
            # stop, and a partial read must not report a whole-file verdict.
            _devnull = os.open(os.devnull, os.O_WRONLY)
            os.dup2(_devnull, sys.stdout.fileno())
            sys.exit(0)
try:
    sys.stdout.flush()
except BrokenPipeError:
    _devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(_devnull, sys.stdout.fileno())
    sys.exit(0)
if bad:
    shown = ', '.join(str(b) for b in bad[:10])
    more = '' if len(bad) <= 10 else f' (+{len(bad)-10} more)'
    print(f"jsonl-read: SKIPPED {len(bad)} unparseable row(s) of {n+len(bad)} in {path} "
          f"— line(s) {shown}{more}. Counts below are over {n} rows, NOT the whole file.",
          file=sys.stderr)
    sys.exit(1)
PY
  local rc=$?
  if [ "$rc" -eq 1 ] && [ -z "${JSONL_STRICT:-}" ]; then return 0; fi
  return "$rc"
}
