# Codebase Tutor

[![Version](https://img.shields.io/badge/version-0.1.0-orange)](package.json)
[![License](https://img.shields.io/badge/License-MIT-BD2D2D)](LICENSE)
[![CI](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%20in%20CI-339933?logo=node.js&logoColor=white)](.github/workflows/ci.yml)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.1-F69220?logo=pnpm&logoColor=white)](package.json)

[中文](README.md) ｜ English

## Overview

Give it a repository path and it reads the repository into a structure it can talk about, then answers questions about that repository.

Static analysis is the base: a symbol-level dependency graph plus per-file summaries, and four deterministic artifacts (control-flow graphs, intra-function data flow, type relations, registry and config index) stored in the `.tutor/` `static_fact` table — they enter no cache key, so adding an analysis class never re-bills an imported repository. Question answering and diagram edits go through one agent that searches, reads files and queries those artifacts itself rather than guessing; diagram modules point directly at files, directories or symbols. Exercise generation is not part of that loop: the exercise route makes a single model call.

Everything runs on your machine and artifacts stay in the analysed repository's `.tutor/`. It starts without a model configured; with a model it bills per repository, and the monthly budget stops calls before they are sent.

## Features

- Import any local repository: indexing, graph and summaries in one pass, with `.tutorignore` for exclusions
- The teaching pane is just the repository tree: selecting a file or directory sets the teaching scope, and the thread is bound to it
- Architecture canvas is a gallery plus an infinite canvas: your drags and renames are saved, node and edge changes are proposed by the agent from code evidence and written directly, with every structural edit versioned and restorable
- Exercises in three families: rule-generated comprehension questions are graded deterministically; LLM-generated comprehension questions are graded by a model matching your answer against the rubric and reference answer (`automatic=false`); code questions are drafted by the model and graded by running tests in a sandbox; mastery and pending reviews follow your answers
- Chat spans design / teaching / practice scopes with separate threads, streamed output and a stop action
- The cost page reports aggregate amounts bucketed by scene, provider and day; every `LlmProvider` call is logged as one line in `~/.codebase-tutor/llm.log` with its scene and tokens (local Ollama summaries fetch on their own and never reach this line); browsing structure, diagrams and capability lists costs nothing
- Multiple repositories mounted at once, file watching, impact analysis after changes, with chat history and audit events on disk
- External tools (MCP) are off by default: with no server in the config file not one tool is added; for an added server, omitting `allowedTools` hands every tool it reports to the model, and writing it admits only the tools on the list. Skills follow the industry directory convention and are read from `~/.codebase-tutor/skills` and `~/.claude/skills` (never from the repository under study); secrets in a skill body are stripped
- Isolation uses the macOS built-in Seatbelt (`/usr/bin/sandbox-exec`); Linux is not implemented yet. Off macOS or when the probe fails, the code-exercise domain stays off — and the gate is checked before anything is billed

## Quick start

```bash
pnpm install
cp .env.example .env   # all values may stay blank; summaries and rule-made questions use the deterministic tier
pnpm dev               # engine 127.0.0.1:3001, UI 127.0.0.1:3000
```

Open `http://127.0.0.1:3000` and import a repository by absolute path. The engine reads the `.env` in this tool's own project root (not the analysed repository's), and variables already present in the environment take precedence; model, rates and usage are configured on the cost page.

## License

MIT — see [LICENSE](LICENSE).
