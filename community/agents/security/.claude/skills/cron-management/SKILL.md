---
name: cron-management
description: "The user wants something to happen on a recurring schedule, or you just restarted and need to verify your crons are still running. You need to create a new scheduled task, restore crons that were lost on restart, add or remove a cron from config.json so it persists across sessions, or troubleshoot why a scheduled workflow stopped firing. Crons die on restart — this skill is how you ensure scheduled work survives."
triggers: ["remind me", "every day", "every hour", "every week", "schedule", "recurring", "daily", "weekly", "cron", "loop", "check regularly", "monitor", "keep an eye on", "set up a reminder", "repeat every", "run every", "automate", "schedule task", "restore crons", "crons missing", "cron not firing", "session start crons", "recreate crons", "persist cron", "add to config.json"]
---

# Cron Management

`config.json` under the `crons` array is the single source of truth for ALL scheduled tasks — recurring AND one-shot reminders. Every cron you create must be written to config.json first so it survives restarts.

## Two cron types

**Recurring** — fires on a repeating interval forever.
```json
{ "name": "heartbeat", "type": "recurring", "interval": "4h", "prompt": "Read HEARTBEAT.md and follow its instructions." }
```

**Once** — fires at a specific datetime, then is deleted.
```json
{ "name": "remind-user-3pm", "type": "once", "fire_at": "2026-04-02T15:00:00Z", "prompt": "Remind the user about the 3pm call." }
```

`type` defaults to `"recurring"` if omitted (backward compatible with existing config.json files).

---

## On Session Start

Crons are **daemon-managed** — they auto-load from `crons.json` on daemon start. No manual restoration needed.

To verify what's scheduled:
```bash
cortextos bus list-crons $CTX_AGENT_NAME
```

---

## Creating a Recurring Cron

```bash
cortextos bus add-cron $CTX_AGENT_NAME <name> <interval> "<prompt>"
```

Example:
```bash
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 4h "Read HEARTBEAT.md and follow its instructions."
```

Confirm with `cortextos bus list-crons $CTX_AGENT_NAME`. Do NOT use `/loop` — that is session-only and will not survive a restart.

---

## Creating a One-Shot Reminder

When a user asks for a one-time reminder (e.g. "remind me at 3pm"):

1. Write to `config.json` first:
   ```json
   { "name": "remind-user-3pm", "type": "once", "fire_at": "2026-04-02T15:00:00Z", "prompt": "Remind the user about the 3pm call." }
   ```
2. Create the live cron via CronCreate with `recurring: false` and the cron expression for that time
3. After the reminder fires, delete the entry from config.json

---

## Removing a Cron

1. Cancel the active cron via CronDelete
2. Remove the entry from `config.json`

---

## Cron Expiry

Built-in crons expire after 7 days. Since your session restarts via the daemon, this is not an issue — crons are recreated from config.json on each fresh start. The 7-day window covers any normal restart cycle.

---

## Troubleshooting

- Cron not firing after restart: check config.json — the entry may be missing or have an expired fire_at
- Duplicate crons: always run CronList before recreating; if a cron is already active, skip it
- One-shot that already fired: if fire_at is in the past and the entry is still in config.json, the reminder was likely missed during a restart — delete the entry, notify the user
