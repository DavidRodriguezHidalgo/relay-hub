# Relay Hub

One place for all your Claude Code sessions. Milestone 1: index and read.

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

## Layout

```
apps/desktop      Electron (Forge + Vite + React)
packages/engine   session indexing; no Electron imports
packages/shared   types and IPC contract
```

Design: `docs/superpowers/specs/2026-09-23-relay-hub-design.md`
