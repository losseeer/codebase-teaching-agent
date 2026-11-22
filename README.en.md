# Codebase Tutor

[![Version](https://img.shields.io/badge/version-0.1.0-orange)](package.json)
[![License](https://img.shields.io/badge/License-MIT-BD2D2D)](LICENSE)
[![CI](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%20in%20CI-339933?logo=node.js&logoColor=white)](.github/workflows/ci.yml)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.1-F69220?logo=pnpm&logoColor=white)](package.json)

[中文](README.md) ｜ English

A local-first code learning assistant: give it a repository path, and it turns the repository into structure it can explain before answering questions about it.

## Contents

- [Features](#features)
- [Workspaces](#workspaces)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Where data lives](#where-data-lives)
- [Development](#development)
- [License](#license)

## Features

- **Static analysis first**: symbol-level dependency graph and per-file summaries, plus four deterministic artifact kinds (control flow, intra-function dataflow, type relations, registration/config index) stored in the `.tutor/` `static_fact` table. They stay out of cache keys, so adding an analysis kind never makes imported repositories pay for model calls again.
- **Agent gathers its own evidence**: chat and diagram edits share one tool loop; the agent searches, reads files, and queries those artifacts instead of guessing. Diagram modules point directly at files, directories, or symbols.
- **Exercise families**: rule-generated comprehension questions are graded deterministically; LLM-generated ones are graded against a rubric and reference answer; code questions are drafted by the model and graded by running tests in a sandbox. Mastery and pending reviews follow your answers.
- **Cost visibility**: the cost page reports totals by scene, provider, and day. Every `LlmProvider` call writes one line to the tool's `llm.log` with its scene and token counts. Browsing structure, diagrams, and capability lists costs nothing.
- **Optional external tools**: MCP is off by default — no server in the config means no tools added. Skills follow the standard directory convention, are read from the user skill directories (never from the repository under study), and secrets in skill bodies are stripped.
- **Sandbox isolation**: code exercises use the macOS built-in Seatbelt (`/usr/bin/sandbox-exec`); Linux is not implemented yet. Off macOS or when the probe fails, the code-exercise domain stays off, and the gate is checked before anything is billed.
- **Read-only learning**: no code changes, no coding-agent tool permissions or approval flow.

## Workspaces

| Workspace | Purpose |
|---|---|
| Architecture overview | Module boundaries, dependencies, and calls on an infinite canvas; drags and renames are saved, structural edits are proposed by the agent from code evidence, and every edit is versioned and restorable |
| Code Q&A | The repository tree is the workspace: selecting a file or directory sets the teaching domain, with symbol anchors as evidence |
| Practice | Generate, sandbox-verify, grade, and review exercises; topics are user-defined, and the question bank can be reviewed or deleted |

Chat across these workspaces keeps separate threads, streams output, and supports stopping a turn.

## Architecture

A pnpm-workspaces monorepo in TypeScript:

| Package | Responsibility |
|---|---|
| `packages/analysis` | Parsing, dependency graph, static fact extraction |
| `packages/contract` | Shared API schemas and types |
| `packages/domain` | Domain models, teaching policies, audit event definitions |
| `packages/engine` | Fastify server, import/reanalysis, LLM tool loop, exercise sandbox, persistence |
| `packages/gui` | Vite + React UI, canvas, three workspaces |
| `packages/platform` | Logging, traces, paths, platform adapters |

Engine and GUI talk over HTTP / SSE. Multiple repositories can be mounted with file watching and impact analysis after changes.

## Quick start

Requires Node.js 22+ and pnpm 10.11.1.

```bash
pnpm install
cp .env.example .env   # all values may be left empty
pnpm dev               # engine 127.0.0.1:3001, GUI 127.0.0.1:3000
```

Open `http://127.0.0.1:3000` and import an absolute repository path. The engine reads `.env` from **this tool's** project root (not the analyzed repository); existing environment variables take precedence. Models, pricing, usage, and budgets are configured in "Manage Config" in the UI.

## Configuration

See [.env.example](.env.example) for the full list. Common settings:

| Variable | Purpose |
|---|---|
| `TUTOR_LLM_PROVIDER` / `TUTOR_LLM_MODEL` | Provider and model; `openai-compatible` and `openai` are supported |
| `OPENAI_API_KEY` | API key; can also be set in the UI, where only a masked value is returned |
| `TUTOR_OPENAI_URL` / `TUTOR_OLLAMA_URL` | Custom endpoints; Ollama uses the compatible endpoint |
| `TUTOR_INPUT_USD_PER_MILLION`, etc. | Pricing used for the pre-request budget gate |
| `TUTOR_SUMMARY_PROVIDER` | Summary provider; deterministic fallback when no model is configured |
| `ENGINE_PORT` | Engine port, default 3001 |
| `TUTOR_ALLOWED_ORIGINS` | Allowed browser origins |

Local models need no API key — configure the compatible endpoint for your provider.

## Where data lives

- **Analyzed repository `.tutor/`**: index, dependency graph, summaries, static facts, question bank, diagrams, and `journal.jsonl`. This is product data that travels with the repository; removing an address-book entry does not delete it.
- **Tool data directory**: profile, model configs, skills, work log, and model-call log — not part of the analyzed repository.

Source code is never uploaded, and the tool never commits or pushes changes for you.

## Development

```bash
pnpm lint        # type-check every package
pnpm test        # unit tests for every package
pnpm build       # build every package
pnpm test:e2e    # Playwright end-to-end tests
```

CI runs on pushes to `main` and on all pull requests: install → lint → test → build → Playwright.

## License

MIT — see [LICENSE](LICENSE).
