# Tavern — notes for Claude Code

The full brief is in [docs/SPEC.md](docs/SPEC.md). Read it before changing anything.

## Non-negotiables

1. The LLM never writes state. It proposes typed deltas through tool calls; the server validates and applies them.
2. All randomness (dice) happens on the server.
3. Only the server calls the LLM, one turn at a time per room.
4. API keys live only in server environment variables, never in client code.
5. Every state change is an append-only event with a per-room sequence number.

## Working rules

- Build one phase at a time (SPEC → Build phases). Stop at the end of each phase, run its acceptance tests, summarise.
- Tests first for the reducer, the delta validator and the prompt builder.
- Every LLM / image provider sits behind an interface with a mock; tests run offline.
- Ask before adding a dependency that is not in the SPEC stack list.

## Layout

- `packages/shared` — zod schemas, event types, presets, pure reducer (`apply`, `replay`).
- `apps/server` — Fastify + Socket.io, SQLite (better-sqlite3 + Drizzle), GM pipeline.
- `apps/web` — React + Vite client.

## Commands

- `pnpm install` · `pnpm test` · `pnpm typecheck`
- Relative imports use explicit `.ts` extensions (Node runs TypeScript via type stripping).
