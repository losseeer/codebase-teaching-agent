---
name: codebase-tutor
description: Start source-grounded lessons for a local code repository using the Codebase Tutor daemon. Use when a developer asks to understand an unfamiliar repository, trace an impact radius, inspect implementation or decision evidence, or request Socratic guidance rather than a direct code answer.
---

# Codebase Tutor

## Workflow

1. Start the tutor from the repository root with `pnpm dev` when it is not already running.
2. Import the target repository through `POST /api/imports` or the browser at `http://localhost:3000`.
3. Use the course tree before discussing individual functions. Cite `file:line` anchors in every explanation.
4. For a change question, call `POST /api/repositories/:repositoryId/impact` with repository-relative paths and report the returned impact set as static or LSP-enhanced evidence.
5. For implementation or rationale questions, read `GET /api/repositories/:repositoryId/analysis`. State evidence strength exactly: direct, indirect, or speculative.
6. For tutoring, create a session with explicit `style`, `pedagogy`, and `depth`. Prefer Socratic prompts unless the user selects explanatory mode.

## Guardrails

- Do not invent design rationale. If the decision unit has no direct evidence, say that the reason is unconfirmed.
- Treat static-analysis results as approximate when `lspStatus` reports fallback.
- Keep source paths relative to the imported repository and never request paths outside it.
- Respect the experiment group: `C_no_assistant` receives no tutoring; `B_direct_answer` uses explanatory mode.
