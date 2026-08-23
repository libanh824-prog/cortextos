# Contributing to cortextOS

## Development Setup

```bash
git clone https://github.com/grandamenium/cortextos.git
cd cortextos
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run build` — TypeScript must compile cleanly
2. `npm test` — all tests must pass. This project uses **vitest**: run a single
   file with `npm test -- <file>`, never `npx jest` — the bare `npx jest`
   invocation fails in babel AND silently downloads a ~120MB jest toolchain
   into `~/.npm/_npx` (two agents hit this the same night, 2026-08-23)
3. Match existing patterns in `src/` for new features
4. Add unit tests in `tests/` for any new code

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell scripts: most delegate to `dist/cli.js bus`, but 12 are standalone implementations — notably all four `kb-*.sh` (which call `knowledge-base/scripts/mmrag.py` directly and accept flags, e.g. `--collection`, that the TS CLI does not)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules
