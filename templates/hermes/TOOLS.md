# Tools Quick Reference

All cortextOS commands: `cortextos bus <command>`. These are shell commands — run them with your bash tool.

---

## Environment Variables

| Variable | Value |
|---|---|
| `CTX_AGENT_NAME` | Your agent name |
| `CTX_ORG` | Org name |
| `CTX_ROOT` | `~/.cortextos/{instance}` |
| `CTX_FRAMEWORK_ROOT` | Framework repo root |
| `CTX_TELEGRAM_CHAT_ID` | Your Telegram chat ID |
| `CTX_ORCHESTRATOR_AGENT` | Name of your orchestrator agent |
| `CTX_TIMEZONE` | Your local timezone |

Shared secrets: `orgs/{org}/secrets.env`
Agent secrets: `orgs/{org}/agents/{agent}/.env`

---

## Command Index

### Tasks
| Command | What it does |
|---|---|
| `create-task "<title>" --desc "<desc>"` | Create a task (visible on dashboard) |
| `update-task <id> <status>` | Update status: pending / in_progress / blocked / completed |
| `complete-task <id> --result "<what>"` | Mark done with result |
| `list-tasks [--status S] [--agent A]` | List / filter tasks |
| `check-stale-tasks` | Find tasks stale >2h in_progress |
| `check-human-tasks` | Check for stale human-assigned tasks |

### Messages
| Command | What it does |
|---|---|
| `send-message <agent> <priority> '<text>' [reply_to]` | Send to another agent |
| `check-inbox` | Check incoming messages (run every heartbeat) |
| `ack-inbox "<msg_id>"` | ACK a message (un-ACK'd re-deliver after 5 min) |
| `notify-agent <agent> "<msg>"` | Urgently signal agent's fast-checker |

### Telegram
| Command | What it does |
|---|---|
| `send-telegram <chat_id> "<msg>"` | Message the user |
| `send-telegram <chat_id> "<caption>" --image <path>` | Send a photo |
| `send-telegram <chat_id> "<caption>" --file <path>` | Send any file |
| `post-activity "<msg>"` | Post to org activity channel |

### Events & Heartbeat
| Command | What it does |
|---|---|
| `log-event <category> <name> <severity> --meta '<json>'` | Log structured event |
| `update-heartbeat "<task summary>"` | Prove you're alive to the dashboard |
| `read-all-heartbeats [--format json\|text]` | Aggregate fleet heartbeats |

### Approvals
| Command | What it does |
|---|---|
| `create-approval "<title>" <category> "[context]"` | Request human approval |
| `update-approval <id> <approved\|rejected> "[note]"` | Resolve an approval |
| `list-approvals [--status S]` | List approvals |

### Knowledge Base
| Command | What it does |
|---|---|
| `kb-query "<question>" --org $CTX_ORG` | Semantic search |
| `kb-ingest <path> --org $CTX_ORG --scope private\|shared` | Index files into KB |
| `kb-collections --org $CTX_ORG` | List available collections |

### Discovery & Fleet
| Command | What it does |
|---|---|
| `list-agents [--org O] [--format json\|text]` | All agents in system |
| `list-skills [--format text\|json]` | Skills available to this agent |

### Goals
| Command | What it does |
|---|---|
| `cortextos goals generate-md --agent <name> --org <org>` | Rebuild GOALS.md from goals.json |

### Reminders
| Command | What it does |
|---|---|
| `create-reminder "<fire_at>" "<prompt>"` | Persistent reminder (survives restart) |
| `list-reminders [--all]` | List pending reminders |
| `ack-reminder <id>` | Acknowledge a fired reminder |

---

## ⚠️ Reading `message-history.jsonl` — never bare `jq`

`$CTX_ROOT/logs/message-history.jsonl` can contain a **torn write**: an unclean stop mid-append (a reboot or crash) leaves NUL bytes where an appended record's data pages were lost, followed by an intact record. The known instance was a **kernel-upgrade reboot, 2026-07-09 06:41:27Z**, pinned from the bracketing timestamps and `last reboot` — not from a guess at which outage it was. **`jq` aborts the stream at that line and exits**, so it returns only the rows *before* the damage **as if they were the whole file** — no error unless you check `$?`, and nobody does in `jq … | sort | uniq -c`.

Measured on the command org, 2026-08-23: `jq` returned **2442** rows of **6048**. It under-reports toward *"nothing there"*, which is the worst direction for an absence claim — it nearly produced a false "no such event" conclusion.

**Use the shared tolerant reader**, which recovers NUL-prefixed rows and **announces anything it skips**:

```bash
# The reader is fleet-shared tooling maintained by the analyst agent:
source "${CTX_FRAMEWORK_ROOT:?}/orgs/${CTX_ORG:?}/agents/analyst/scripts/lib/jsonl-read.sh"
jsonl_read "$CTX_ROOT/logs/message-history.jsonl"      # rows on stdout, skip report on stderr
JSONL_STRICT=1 jsonl_read "$file"                       # also exits 1 if anything was skipped
```

A tolerant reader that skips **silently** is the same defect one layer up, so this one always reports what it could not parse, with line numbers.

**Never "repair" the log by deleting a line** — it is an append-only shared record and deleting rewrites history. Leave it, or append a marker so the corruption stays visible.

**Sanity check for any jsonl:** `jq -c . f | wc -l` and `jsonl_read f | wc -l` should be EQUAL. If they differ, jq is truncating.
