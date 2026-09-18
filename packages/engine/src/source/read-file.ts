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
  2. 拒读名单——.env*（仓库根 .env 有真实 API key，读到即入 prompt 发往远端；但 .env.example/.sample/
     .template 这类**模板**只列键名、不含密钥，放行）、密钥与凭据载体（私钥 id_rsa 类、.npmrc/.netrc/
     credentials.json 等）、.git / node_modules / .tutor 目录、二进制文件后缀；
  3. 单次窗口上限（行数/字符数）——**字符数是真正的闸**：逐行装进预算，超预算就少给整行，
     并把**实得行区间**写进首行（不是请求区间），另给出继续读的 offset；
  4. 一切拒绝/失败以文本结果返回给模型（可自行改参数重试），不抛异常中断对话。
  每次调用（无论成败）由调用方记 journal file_read 事件审计。

  ⚠️ 本护栏按**文件名**判定，挡得住「.env / 私钥文件」这类约定位置，挡不住把口令写进
  `config.yaml` / `docker-compose.yml` 的正文——那是内容判定，不在本函数职责内。
  */

/** 行数上限（工具对模型的承诺）与字符预算（真正的闸：逐行装，超预算就少给整行）。 */
const MAX_WINDOW_LINES = 400;
const DEFAULT_WINDOW_LINES = 150;
const MAX_WINDOW_CHARS = 12_000;
const MAX_FILE_BYTES = 2_000_000;

const DENIED_DIRECTORIES = new Set([".git", "node_modules", ".tutor"]);
/** 模板类 env 文件只列键名、不含密钥，而且是理解配置的入口 → 放行（不加区分地挡 .env* 是误伤）。 */
const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];
/** 这些载体要么没扩展名、要么扩展名太通用，只能按文件名挡：全小写比较。 */
const DENIED_BASENAMES = new Set([
  // OpenSSH 私钥默认无扩展名
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  // 明文口令/令牌
  ".netrc", "_netrc", ".npmrc", ".pypirc", ".htpasswd", ".git-credentials", ".dockercfg",
  // 云厂商凭据
  "credentials", "credentials.json"
]);
const DENIED_EXTENSIONS = new Set([
  // 密钥/证书
  ".key", ".pem", ".p12", ".pfx", ".p8", ".crt",
  // 二进制
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svgz", ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar", ".pdf", ".mp3", ".mp4", ".mov", ".wav",
  ".wasm", ".node", ".dylib", ".so", ".dll", ".exe", ".jar", ".class", ".pyc"
]);

export const READ_FILE_TOOL: LlmTool = {
  name: "read_file",
  description: "读取当前项目内一个文本文件（源码/配置）的指定行窗口，返回带行号的内容；首行会说明本次实际返回的行区间与文件总行数，内容没给全时会附上继续读的 offset。用于查看项目结构全景之外的实现细节。禁止用于读取密钥或仓库外路径。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "仓库内相对路径，如 src/app.ts" },
      offset: { type: "integer", description: "起始行号（1 起），默认 1" },
      limit: { type: "integer", description: `读取行数，默认 ${DEFAULT_WINDOW_LINES}，上限 ${MAX_WINDOW_LINES}；单次返回还受约 ${MAX_WINDOW_CHARS} 字符的预算限制，一次拿不完就按首行给的 offset 继续读` }
    },
    required: ["path"]
  }
};

/** read_file 审计记录（无论成败；由调用方逐条记 journal file_read）。 */
export interface FileReadRecord {
  path: string;
  /** 本次**实际返回**的行数（不是请求的行数）。 */
  lines?: number;
  bytes?: number;
  /** 请求的行没给全（被字符预算截住，或某一行本身就超预算被切）。首行会说明实得区间与续读 offset。 */
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
  const extension = extensionOf(base);
  // .env 要两头都查：前缀挡住 .env/.env.local，后缀挡住 prod.env/local.env 这类写法；
  // 模板（.env.example 等）只列键名，放行。
  const isEnvTemplate = ENV_TEMPLATE_SUFFIXES.some((suffix) => base.toLowerCase().endsWith(suffix));
  if ((base.startsWith(".env") || extension === ".env") && !isEnvTemplate) return deny("环境变量文件可能包含密钥，禁止读取");
  if (DENIED_BASENAMES.has(base.toLowerCase())) return deny("该文件通常是密钥/凭据载体，不开放读取");
  if (DENIED_EXTENSIONS.has(extension)) return deny("该文件类型不开放读取");
  try {
    const bytes = statSync(absolute).size;
    if (bytes > MAX_FILE_BYTES) return deny(`文件过大（${bytes} 字节）`);
    const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
    const offset = Math.max(1, Math.floor(Number(args.offset ?? 1) || 1));
    const limit = Math.min(MAX_WINDOW_LINES, Math.max(1, Math.floor(Number(args.limit ?? DEFAULT_WINDOW_LINES) || DEFAULT_WINDOW_LINES)));
    const start = Math.min(offset, Math.max(1, lines.length));
    const requestedEnd = Math.min(lines.length, start - 1 + limit);
    // 逐行装进字符预算：宁可少给几行，也不把一行切一半 —— 否则首行那句「第 X-Y 行」就不成立，
    // 模型会以为自己看到了没给它的行。
    const kept: string[] = [];
    let used = 0;
    for (let index = start - 1; index < requestedEnd; index += 1) {
      const rendered = `${index + 1}| ${lines[index]}`;
      if (kept.length && used + rendered.length + 1 > MAX_WINDOW_CHARS) break;
      kept.push(rendered);
      used += rendered.length + 1;
    }
    // 极端情况：单行本身就超预算（压缩过的 JS/JSON）→ 只能按字符切，并在首行说明该行只给了前半段
    let numbered = kept.join("\n");
    const cutMidLine = numbered.length > MAX_WINDOW_CHARS;
    if (cutMidLine) numbered = numbered.slice(0, MAX_WINDOW_CHARS);
    const end = start + kept.length - 1;
    const truncated = end < requestedEnd || cutMidLine;
    const total = end < lines.length ? `，共 ${lines.length} 行` : "";
    const hint = truncated ? `，已达单次字符上限，继续读请用 offset=${cutMidLine ? end : end + 1}` : "";
    const header = `文件 ${relative}（第 ${start}-${end} 行${total}${hint}）`;
    return { content: `${header}：\n${numbered}`, audit: { path: relative, lines: kept.length, bytes, truncated, denied: false } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取失败";
    const hint = message.includes("ENOENT") ? "路径不存在；请对照「项目结构全景」里的真实路径拼写重试。" : "";
    return {
      content: `读取 ${rawPath} 失败：${message}${hint ? `（提示：${hint}）` : ""}`,
      audit: { path: rawPath, truncated: false, denied: true, error: message }
    };
  }
}
