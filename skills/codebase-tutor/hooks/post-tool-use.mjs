#!/usr/bin/env node

const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => void forward());

async function forward() {
  try {
    const payload = JSON.parse(chunks.join(""));
    if (payload.hook_event_name && payload.hook_event_name !== "PostToolUse") return;
    const toolInput = record(payload.tool_input);
    const path = string(toolInput.file_path) ?? string(toolInput.path) ?? string(toolInput.filePath);
    const toolResponse = text(payload.tool_response);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 650);
    try {
      await fetch(`${process.env.TUTOR_ENGINE_URL ?? "http://127.0.0.1:3001"}/api/companion/hooks/post-tool-use`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          hookEventName: "PostToolUse",
          toolName: string(payload.tool_name),
          toolInput,
          toolResponse,
          cwd: string(payload.cwd) ?? process.cwd(),
          path,
          command: string(toolInput.command),
          exitCode: number(payload.exit_code),
          durationMs: number(payload.duration_ms),
          output: toolResponse,
          sessionId: string(payload.session_id)
        })
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Hooks must not block Claude Code when the local tutor is unavailable.
  }
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function string(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value) {
  if (typeof value === "string") return value.slice(0, 8_000);
  if (value === undefined || value === null) return undefined;
  try { return JSON.stringify(value).slice(0, 8_000); } catch { return undefined; }
}
