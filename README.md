# Relay Hub

One place for all your Claude Code sessions. Milestone 1: index and read. Milestone 2: drive a session with approvals.

## Run

```
pnpm install
pnpm dev                                  # Electron app
pnpm test                                 # engine + renderer unit tests
pnpm --filter @relay/desktop test:e2e     # packages the app, then the Playwright smoke test
```

If `pnpm dev` fails with "Electron failed to install correctly", the binary
was not downloaded during install; run `node node_modules/electron/install.js`
once.

## Driving a session (M2)

Select a session and use the dev box at the bottom of its panel (dev builds only). Modes:
`steer` (now), `queue` (after the current turn), `interrupt` (abort, then send). Destructive
git commands and paths outside the session directory wait in the approvals drawer; a macOS
notification fires when one is waiting. A session whose transcript was written in the last
15 s by another process (a terminal) is refused, so a session is driven from one place at a time.

## Layout

```
apps/desktop      Electron (Forge + Vite + React)
packages/engine   session indexing; no Electron imports
packages/shared   types and IPC contract
```

Design: `docs/superpowers/specs/2026-09-23-relay-hub-design.md`
