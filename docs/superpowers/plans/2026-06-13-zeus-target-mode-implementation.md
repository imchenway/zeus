# Zeus Target Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Zeus as a local-first macOS AI development workbench according to `/Users/david/hypha/zeus/docs/zeus_development_design.md`.

**Architecture:** A pnpm monorepo hosts an Electron desktop app and focused TypeScript packages for local server, storage, domains, AI runtime, Git, code indexing, graph generation, Telegram, and security. The first executable slice establishes real local data flow from SQLite and current repository scanning instead of mock data.

**Tech Stack:** Electron, React, TypeScript, Vite, Fastify, WebSocket, SQLite, Vitest, Playwright-ready structure, electron-builder, pnpm workspace.

---

## File Structure

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `prettier.config.js`: workspace and quality gates.
- `packages/shared`: DTOs, enums, event contracts, utility types.
- `packages/storage`: SQLite connection, schema creation, repositories, temp-db tests.
- `packages/project-core`: project creation/update/list rules using real local paths.
- `packages/task-core`: task state machine and task service.
- `packages/local-server`: Fastify app, health check, project/task/git/runtime/graph APIs.
- `packages/code-indexer`: scanner CLI and extractors over real files.
- `packages/graph-engine`: graph CLI, node/edge generation, non-empty assertion.
- `packages/ai-runtime`: CLI detection and PTY runtime boundary.
- `packages/git-core`: git status/diff wrappers.
- `packages/security-core`: localhost/token/desensitization policy.
- `packages/telegram-adapter`: settings and command parser with unconfigured state.
- `apps/desktop`: Electron main/preload/renderer and electron-builder config.
- `scripts`: dev/build/test-real-scan/package/verify scripts.
- `docs`: project documentation required by the design.

## Task 1: Workspace Bootstrap

- [ ] Write failing tests for shared enums and task state transitions.
- [ ] Run the focused tests and verify they fail because packages do not exist.
- [ ] Create pnpm workspace, TypeScript config, Vitest config, and shared/task-core packages.
- [ ] Run focused tests and verify they pass.
- [ ] Run `pnpm install`, `pnpm typecheck`, and `pnpm test`.

## Task 2: Storage and Domain Core

- [ ] Write failing storage tests using a temporary SQLite file.
- [ ] Verify tests fail because migrations/repositories do not exist.
- [ ] Implement schema creation for core tables and repositories without seed data.
- [ ] Add project and task services that persist only user-created real records.
- [ ] Run storage/domain tests and typecheck.

## Task 3: Local Server

- [ ] Write failing API tests for `/health`, project creation, task creation, runtime status, and Git status.
- [ ] Verify tests fail because the server does not exist.
- [ ] Implement Fastify server bound to `127.0.0.1`, token guard, routes, and event log writes.
- [ ] Run local-server tests and typecheck.

## Task 4: Real Code Scan and Graph

- [ ] Write failing CLI tests that scan `/Users/david/hypha/zeus` and expect real files to produce symbols.
- [ ] Verify tests fail because scan CLI does not exist.
- [ ] Implement file inventory, TS/JS/package extractors, Java/MyBatis/SQL extractor boundaries, and graph node/edge generation.
- [ ] Implement `scripts/test-real-scan.sh` and `pnpm test:real-scan`.
- [ ] Run `pnpm test:real-scan` and record symbol/node/edge counts.

## Task 5: Desktop App Shell

- [ ] Write renderer tests for Dashboard empty state, project list empty state, settings unavailable states.
- [ ] Verify tests fail because UI does not exist.
- [ ] Implement Electron main, preload, React app shell, pages, API client, and empty states.
- [ ] Add local run script and Codex Run action if the desktop app can launch.
- [ ] Run renderer tests and app build.

## Task 6: Runtime, Git, Telegram, Security, Release

- [ ] Write tests for AI CLI unavailable state, Telegram unconfigured state, Git status parsing, and token desensitization.
- [ ] Verify tests fail for missing implementations.
- [ ] Implement adapters and settings UI without fake external results.
- [ ] Configure electron-builder, unsigned mac packaging, Homebrew cask template, CI workflows, and docs.
- [ ] Run full verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:real-scan`, `pnpm build`, `pnpm package:mac`.

## Self Review

- No intentional fake business data is introduced.
- All implementation tasks move toward the full design, not a demo-only substitute.
- External missing conditions are represented as explicit unavailable/unconfigured states.
- Git commit steps are omitted because the project-level AGENTS instruction forbids autonomous commit operations unless the user asks.
