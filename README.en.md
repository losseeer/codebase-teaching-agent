# Codebase Tutor

[![Version](https://img.shields.io/badge/version-0.1.0-orange)](package.json)
[![License](https://img.shields.io/badge/License-MIT-BD2D2D)](LICENSE)
[![CI](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%20in%20CI-339933?logo=node.js&logoColor=white)](.github/workflows/ci.yml)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.1-F69220?logo=pnpm&logoColor=white)](package.json)

[中文](README.md) ｜ English

## Overview

Give it a repository path and it reads the repository into a structure it can talk about, then answers questions about that repository.

Static analysis is the base: a symbol-level dependency graph plus per-file summaries, and four deterministic artifacts (control-flow graphs, intra-function data flow, type relations, registry and config index) stored in the `.tutor/` `static_fact` table — they enter no cache key, so adding an analysis class never re-bills an imported repository. Question answering, exercise generation and diagram edits all go through one agent that searches, reads files and queries those artifacts itself rather than guessing; diagram modules point directly at files, directories or symbols.

Everything runs on your machine and artifacts stay in the analysed repository's `.tutor/`. It starts without a model configured; with a model it bills per repository, and the monthly budget stops calls before they are sent.

## Features

- Import any local repository: indexing, graph and summaries in one pass, with `.tutorignore` for exclusions
- The teaching pane is just the repository tree: selecting a file or directory sets the teaching scope, and the thread is bound to it
- Architecture canvas is a gallery plus an infinite canvas: your drags and renames are saved, node and edge changes are proposed by the agent from code evidence and written directly, with every structural edit versioned and restorable
- Exercises in two families: comprehension questions graded deterministically, code questions graded by running tests in a sandbox; mastery and pending reviews follow your answers
- Chat spans design / teaching / practice scopes with separate threads, streamed output and a stop action
- The cost page reports scene, latency, tokens and amount per model call; browsing structure, diagrams and capability lists costs nothing
- Multiple repositories mounted at once, file watching, impact analysis after changes, with chat history and audit events on disk
- External skills and tools are not added by default and stay behind an allow-list once added; if sandbox isolation probes fail, the code-exercise domain stays off

## Quick start

```bash
pnpm install
cp .env.example .env   # all values may stay blank; summaries fall back to local heuristics
pnpm dev               # engine 127.0.0.1:3001, UI 127.0.0.1:3000
```

Open `http://127.0.0.1:3000` and import a repository by absolute path. The engine reads a repo-root `.env` automatically, and variables already present in the environment take precedence; model, rates and usage are configured on the cost page.

## License

MIT — see [LICENSE](LICENSE).
