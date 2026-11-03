import type { LlmTool } from "../application/port/llm-provider.js";
import type { ToolDefinition } from "./tools/types.js";

/** 技能正文与附属文件的取用工具声明；正文由 `ctx.skills` 提供，不在此处读盘。 */

export const READ_SKILL_TOOL: LlmTool = {
  name: "read_skill",
  description: "按名字读取技能正文；附属文件用 file 指定相对路径。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "技能清单中的名字" },
      file: { type: "string", description: "可选：技能目录内的相对路径，省略时读取 SKILL.md" }
    },
    required: ["name"]
  }
};

export const READ_SKILL_DEFINITION: ToolDefinition = {
  name: READ_SKILL_TOOL.name,
  summary: READ_SKILL_TOOL.description,
  schema: READ_SKILL_TOOL.parameters,
  exposure: "always",
  effect: "read",
  origin: { kind: "internal" },
  scope: "all",
  available: (ctx) => Boolean(ctx.skills),
  unavailable: "没有装载技能。",
  describe: (args) => ({ label: `加载技能 ${requiredString(args, "name")}`.trim() }),
  invoke: (args, ctx) => {
    if (!ctx.skills) return { text: "没有装载技能。", ok: false };
    const name = requiredString(args, "name");
    const file = optionalString(args, "file");
    ctx.onProgress?.({ type: "loading_skill", skill: name });
    const body = ctx.skills.bodyOf(name, file);
    const found = body !== undefined;
    return {
      text: found ? (body || "（这份技能装好了，但正文是空的：只有 frontmatter，没有可照做的步骤。）") : `没有「${name}」这份技能${file ? `或它目录里的 ${file}` : ""}；清单上的名字以外都不要用。`,
      ok: found,
      detail: found ? "已加载" : "未找到",
      audits: { skillReads: [{ skill: file ? `${name}/${file}` : name, chars: body?.length ?? 0, found }] }
    };
  }
};

function requiredString(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(args: unknown, key: string): string | undefined {
  const value = requiredString(args, key);
  return value || undefined;
}
