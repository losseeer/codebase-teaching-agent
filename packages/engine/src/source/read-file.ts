import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isWithin } from "../lib.js";
import type { LlmTool } from "../llm/provider.js";

/**
  read_file 工具（宏观设计 map 与教学 teaching 两个作用域共用）：让模型按需拉取源码，
  补足「结构全景/调用邻接 + 锚点摘录」之外的深度。练习答疑作用域**不提供**该工具——
  它会绕过「判分答案与锚点不进上下文」的防泄题约束。

  护栏（全部强制，非可选项）：
  1. 路径必须落在仓库内（isWithin），绝对路径/穿越一律拒绝；
  2. 拒读名单——.env*（仓库根 .env 有真实 API key，读到即入 prompt 发往远端）、密钥后缀、
     .git / node_modules / .tutor 目录、二进制文件后缀；
  3. 单次窗口上限（行数/字符数），超限截断并明示 truncated；
  4. 一切拒绝/失败以文本结果返回给模型（可自行改参数重试），不抛异常中断对话。
  每次调用（无论成败）由调用方记 journal file_read 事件审计。
  */

export const READ_FILE_TOOL: LlmTool = {
  name: "read_file",
  description: "读取当前项目内一个文本文件（源码/配置）的指定行窗口，返回带行号的内容。用于查看项目结构全景之外的实现细节。禁止用于读取密钥或仓库外路径。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "仓库内相对路径，如 src/app.ts" },
      offset: { type: "integer", description: "起始行号（1 起），默认 1" },
      limit: { type: "integer", description: "读取行数，默认 150，上限 400" }
    },
    required: ["path"]
  }
};

/** read_file 审计记录（无论成败；由调用方逐条记 journal file_read）。 */
export interface FileReadRecord {
  path: string;
  lines?: number;
  bytes?: number;
  truncated: boolean;
  denied: boolean;
  error?: string;
}

export interface ReadFileOutcome {
  /** 直接回喂给模型的内容（成功=带行号摘录，失败=拒绝/错误说明）。 */
  content: string;
  /** 审计信息；拒绝与失败时 path 仍尽量记录原始请求值。 */
  audit: FileReadRecord;
}

const MAX_WINDOW_LINES = 400;
const DEFAULT_WINDOW_LINES = 150;
const MAX_WINDOW_CHARS = 6_000;
const MAX_FILE_BYTES = 2_000_000;

const DENIED_DIRECTORIES = new Set([".git", "node_modules", ".tutor"]);
const DENIED_EXTENSIONS = new Set([
  // 密钥/证书
  ".key", ".pem", ".p12", ".pfx", ".crt",
  // 二进制
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svgz", ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar", ".pdf", ".mp3", ".mp4", ".mov", ".wav",
  ".wasm", ".node", ".dylib", ".so", ".dll", ".exe", ".jar", ".class", ".pyc", ".lock"
]);

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index).toLowerCase();
}

export function executeReadFile(repoPath: string, argumentsJson: string): ReadFileOutcome {
  let args: { path?: unknown; offset?: unknown; limit?: unknown };
  try {
    args = JSON.parse(argumentsJson || "{}") as typeof args;
  } catch {
    return { content: "read_file 参数不是合法 JSON，请重新调用。", audit: { path: "", truncated: false, denied: true, error: "invalid_json" } };
  }
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) {
    return { content: "read_file 缺少 path 参数。", audit: { path: "", truncated: false, denied: true, error: "missing_path" } };
  }
  const deny = (reason: string): ReadFileOutcome => ({
    content: `已拒绝读取 ${rawPath}：${reason}`,
    audit: { path: rawPath, truncated: false, denied: true, error: reason }
  });
  if (isAbsolute(rawPath) || rawPath.startsWith("~")) return deny("只允许仓库内相对路径");
  const absolute = join(repoPath, rawPath);
  if (!isWithin(repoPath, absolute)) return deny("路径越出仓库范围");
  const relative = rawPath.replaceAll("\\", "/");
  const segments = relative.split("/");
  if (segments.some((segment) => DENIED_DIRECTORIES.has(segment))) return deny("该目录不开放读取");
  const base = segments[segments.length - 1];
  if (base.startsWith(".env")) return deny("环境变量文件可能包含密钥，禁止读取");
  if (DENIED_EXTENSIONS.has(extensionOf(base))) return deny("该文件类型不开放读取");
  try {
    const bytes = statSync(absolute).size;
    if (bytes > MAX_FILE_BYTES) return deny(`文件过大（${bytes} 字节）`);
    const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
    const offset = Math.max(1, Math.floor(Number(args.offset ?? 1) || 1));
    const limit = Math.min(MAX_WINDOW_LINES, Math.max(1, Math.floor(Number(args.limit ?? DEFAULT_WINDOW_LINES) || DEFAULT_WINDOW_LINES)));
    const start = Math.min(offset, Math.max(1, lines.length));
    const end = Math.min(lines.length, start - 1 + limit);
    let numbered = lines.slice(start - 1, end).map((line, index) => `${start + index}| ${line}`).join("\n");
    let truncated = false;
    if (numbered.length > MAX_WINDOW_CHARS) {
      numbered = `${numbered.slice(0, MAX_WINDOW_CHARS)}\n…（内容超长已截断）`;
      truncated = true;
    }
    const header = end < lines.length || truncated ? `文件 ${relative}（第 ${start}-${end} 行，共 ${lines.length} 行）` : `文件 ${relative}（第 ${start}-${end} 行）`;
    return { content: `${header}：\n${numbered}`, audit: { path: relative, lines: end - start + 1, bytes, truncated: truncated || end < lines.length, denied: false } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取失败";
    const hint = message.includes("ENOENT") ? "路径不存在；请对照「项目结构全景」里的真实路径拼写重试。" : "";
    return {
      content: `读取 ${rawPath} 失败：${message}${hint ? `（提示：${hint}）` : ""}`,
      audit: { path: rawPath, truncated: false, denied: true, error: message }
    };
  }
}
