#!/usr/bin/env python3
"""Strict field accessor for the fleet's row stores.

WHY THIS EXISTS
---------------
Five times in two days a query read a field name that did not exist and got a
plausible answer instead of an error:

  .agent / .assignee on task rows      -> the fields are created_by / assigned_to
  .claude_rss_mb on ram-series         -> the field is claude_rss_total_mb
  jsonl-read run instead of sourced    -> empty stream read as n=0 / max=null
  .interval on a cron row              -> the field is schedule; None read as
                                          "the schedules were dropped"
  wc bytes vs len chars                -> a unit, not a field, same shape

Every one produced a number or a None that looked like an answer.  None was
caught by noticing; all were caught by re-reading with the right instrument.
So the fix is not "look the name up" -- a note only works if someone remembers
to open it, and the ad-hoc path is exactly where remembering fails.  The fix is
that a wrong name CANNOT return None.

TWO FAILURE HALVES, BOTH REFUSED
--------------------------------
(a) UnknownField  -- the name is not in the pinned schema at all.  A typo or a
                     guess.  Always an error.
(b) MissingInRow  -- the name IS pinned, but this row does not carry it, because
                     these stores are schema-HETEROGENEOUS over time (measured:
                     ram-series has 5 distinct shapes, axeltire-uptime 3,
                     transcript-size 2, and disk-series interleaves two row types
                     that share a file).  Returning None here is how a bytes
                     computation silently eats inode rows.  An error unless the
                     caller passes an explicit default, which makes the decision
                     visible at the call site.

USE
---
    import sys, os; sys.path.insert(0, os.path.expanduser("~/cortextos/bus/lib"))
    from rowfields import tasks, get

    for t in tasks(status="in_progress"):
        print(get(t, "assigned_to"))      # fine
        print(get(t, "agent"))            # UnknownField, loudly, right here

CLI
---
    rowfields.py schema task
    rowfields.py tasks --status in_progress --fields id,status,assigned_to
    rowfields.py reconcile            # pins vs the live stores; rc 1 = drift

The pins below were MEASURED from the live stores on 2026-09-02, never typed
from memory.  `reconcile` is the control that they still match: a schema is a
claim about what a store contains, and an unchecked pin is a past-tense claim.
"""

import json
import os
import subprocess
import sys

STATE = os.path.expanduser("~/.cortextos/default/state/analyst")
CRON_GLOB = os.path.expanduser(
    "~/.cortextos/default/.cortextOS/state/agents/*/crons.json")


class UnknownField(KeyError):
    """The field name is not in the pinned schema for this row type."""


class MissingInRow(KeyError):
    """The field is pinned but absent from THIS row; pass a default to allow."""


# Measured 2026-09-02 from the live stores.  Union of every observed shape.
SCHEMAS = {
    "task": [
        "archived", "assigned_to", "completed_at", "created_at", "created_by",
        "description", "due_date", "id", "kpi_key", "needs_approval", "org",
        "outputs", "priority", "project", "result", "status", "title", "type",
        "updated_at",
    ],
    "cron": [
        "created_at", "description", "enabled", "fire_count",
        "last_fire_attempted_at", "last_fired_at", "metadata", "name",
        "prompt", "schedule",
    ],
    "ram_series": [
        "claude_procs", "claude_rss_each_mb", "claude_rss_total_mb",
        "mem_avail_mb", "mem_free_mb", "mem_total_mb", "mem_used_mb",
        "other_mb", "postgres_procs", "postgres_rss_total_mb", "swap_cached_mb",
        "swap_total_mb", "swap_used_mb", "ts", "vscode_rss_total_mb",
    ],
    "disk_series": [
        "free_mb", "inodes_free", "inodes_free_pct", "inodes_total",
        "inodes_used", "target", "total_mb", "ts", "used_mb", "used_pct",
    ],
    "axeltire_uptime": [
        "code", "duration", "marker_checked", "marker_ok", "name", "status_ok",
        "too_slow", "ts", "url", "warn_slow",
    ],
    "transcript_size": [
        "dir_mb", "file", "label", "sidecar_mb", "transcript_bytes",
        "transcript_mb", "ts",
    ],
}

# Names that have actually been guessed wrong in production, mapped to the real
# field.  Purely to make the error message useful -- the refusal does not
# depend on this table.
KNOWN_WRONG = {
    ("task", "agent"): "created_by (who filed it) or assigned_to (who works it)",
    ("task", "assignee"): "assigned_to",
    ("task", "owner"): "assigned_to",
    ("task", "source"): "created_by",
    ("cron", "interval"): "schedule",
    ("cron", "cron"): "schedule",
    ("ram_series", "claude_rss_mb"): "claude_rss_total_mb",
    ("transcript_size", "agent"): "label",
}

_SENTINEL = object()


def fields(kind):
    if kind not in SCHEMAS:
        raise UnknownField(
            "no pinned schema for row type %r; known: %s"
            % (kind, ", ".join(sorted(SCHEMAS))))
    return list(SCHEMAS[kind])


def _hint(kind, field):
    fix = KNOWN_WRONG.get((kind, field))
    if fix:
        return "  -- this exact mistake has been made before; the field is %s" % fix
    near = [f for f in SCHEMAS[kind] if field in f or f in field]
    if near:
        return "  -- did you mean: %s" % ", ".join(sorted(near))
    return ""


def get(row, field, kind=_SENTINEL, default=_SENTINEL):
    """Read `field` from `row`, refusing both failure halves.

    kind defaults to the row's own tag when it came from this module.
    Pass `default=` to allow a pinned-but-absent field (heterogeneous stores).
    """
    if kind is _SENTINEL:
        kind = getattr(row, "_kind", None)
        if kind is None:
            raise UnknownField(
                "row has no kind tag; pass kind= explicitly (one of %s)"
                % ", ".join(sorted(SCHEMAS)))
    if field not in SCHEMAS.get(kind, ()):
        raise UnknownField(
            "%r is not a field of row type %r%s\n   pinned fields: %s"
            % (field, kind, _hint(kind, field), ", ".join(SCHEMAS[kind])))
    if field not in row:
        if default is not _SENTINEL:
            return default
        raise MissingInRow(
            "%r is pinned for %r but ABSENT from this row -- these stores are "
            "schema-heterogeneous over time. Pass default= to accept that, "
            "which puts the decision at the call site instead of in a silent "
            "None." % (field, kind))
    # dict.__getitem__ deliberately: row[field] would re-enter
    # StrictRow.__getitem__ and recurse forever. Caught by test 3.
    return dict.__getitem__(row, field)


class StrictRow(dict):
    """A row whose [] and .get() refuse an off-schema name.

    .get() is overridden deliberately: `.get('agent')` returning None IS the
    production defect this module exists to remove.
    """

    def __init__(self, data, kind):
        super().__init__(data)
        self._kind = kind

    def __getitem__(self, field):
        return get(self, field, kind=self._kind)

    def get(self, field, default=_SENTINEL):
        return get(self, field, kind=self._kind, default=default)

    def raw(self):
        return dict(self)


def wrap(rows, kind):
    fields(kind)  # refuse an unknown row type up front
    return [StrictRow(r, kind) for r in rows]


def tasks(**filters):
    """The DEFAULT path for reading task rows. Bare jq is the exception."""
    p = subprocess.run(["cortextos", "bus", "list-tasks", "--format", "json"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("list-tasks rc=%d: %s" % (p.returncode, p.stderr[:300]))
    d = json.loads(p.stdout)
    rows = d if isinstance(d, list) else d.get("tasks", [])
    out = wrap(rows, "task")
    for k, v in filters.items():
        fields("task")
        if k not in SCHEMAS["task"]:
            raise UnknownField("cannot filter on %r%s" % (k, _hint("task", k)))
        out = [r for r in out if r.raw().get(k) == v]
    return out


def crons(agent=None):
    import glob
    out = []
    for f in sorted(glob.glob(CRON_GLOB)):
        who = os.path.basename(os.path.dirname(f))
        if agent and who != agent:
            continue
        d = json.load(open(f))
        cs = d if isinstance(d, list) else d.get("crons", [])
        out.extend(wrap(cs, "cron"))
    return out


def jsonl(kind, path=None):
    path = path or {
        "ram_series": STATE + "/ram-series.jsonl",
        "disk_series": STATE + "/disk-series.jsonl",
        "axeltire_uptime": STATE + "/axeltire-uptime-log.jsonl",
        "transcript_size": STATE + "/transcript-size-log.jsonl",
    }[kind]
    rows, skipped = [], 0
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                skipped += 1
    if skipped:
        sys.stderr.write("rowfields: SKIPPED %d unparseable row(s) in %s\n"
                         % (skipped, path))
    return wrap(rows, kind)


def reconcile(kind, rows):
    """Compare the pin against what the store actually carries.

    Returns (unpinned, unobserved). `unpinned` is the dangerous half: a live
    field no pin knows about means the pin is stale and a correct query would
    be refused.
    """
    observed = set()
    for r in rows:
        observed |= set(r.raw().keys() if isinstance(r, StrictRow) else r.keys())
    pinned = set(SCHEMAS[kind])
    return sorted(observed - pinned), sorted(pinned - observed)


def _cli(argv):
    if len(argv) < 2:
        print(__doc__.strip().split("\n\n")[0])
        print("\nusage: rowfields.py {schema KIND | tasks [--status S] "
              "[--assigned-to A] --fields a,b | reconcile}")
        return 2
    cmd = argv[1]
    if cmd == "schema":
        kind = argv[2]
        print("%s (%d pinned fields, measured 2026-09-02):" % (kind, len(SCHEMAS[kind])))
        for f in fields(kind):
            print("   " + f)
        return 0
    if cmd == "tasks":
        want, filt = None, {}
        i = 2
        while i < len(argv):
            if argv[i] == "--fields":
                want = argv[i + 1].split(","); i += 2
            elif argv[i].startswith("--"):
                filt[argv[i][2:].replace("-", "_")] = argv[i + 1]; i += 2
            else:
                i += 1
        rows = tasks(**filt)
        want = want or ["id", "status", "assigned_to", "title"]
        for f in want:
            if f not in SCHEMAS["task"]:
                sys.stderr.write("rowfields: %r is not a task field%s\n"
                                 % (f, _hint("task", f)))
                return 2
        for r in rows:
            print("\t".join(str(r.get(f, None)) for f in want))
        sys.stderr.write("rowfields: %d row(s)\n" % len(rows))
        return 0
    if cmd == "reconcile":
        rc = 0
        checks = [("task", lambda: tasks()), ("cron", lambda: crons())]
        for k in ("ram_series", "disk_series", "axeltire_uptime", "transcript_size"):
            checks.append((k, (lambda kk: (lambda: jsonl(kk)))(k)))
        for kind, loader in checks:
            try:
                rows = loader()
            except Exception as e:
                print("reconcile %-16s BLIND: %s" % (kind, str(e)[:100]))
                rc = max(rc, 2)
                continue
            unpinned, unobserved = reconcile(kind, rows)
            if unpinned:
                print("reconcile %-16s DRIFT: live fields not pinned: %s"
                      % (kind, ", ".join(unpinned)))
                rc = max(rc, 1)
            else:
                extra = (" (pinned-but-unobserved here: %s)" % ", ".join(unobserved)) if unobserved else ""
                print("reconcile %-16s ok — %d rows, every live field pinned%s"
                      % (kind, len(rows), extra))
        return rc
    sys.stderr.write("rowfields: unknown command %r\n" % cmd)
    return 2


if __name__ == "__main__":
    sys.exit(_cli(sys.argv))
