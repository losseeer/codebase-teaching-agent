import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isWithin } from "@codebase-tutor/platform";
import { maskSecrets } from "@codebase-tutor/domain";
import { CONTEXT_SHARE, contextShare, contextShareLines } from "../adapter/outbound/llm/context-window.js";
import type { LlmTool } from "../application/port/llm-provider.js";

/**
  read_file 工具：读取仓内文本文件的指定行窗口。
  三道检查：仓内路径（含 realpath 复核）、拒读名单、单次窗口预算。
  拒绝与失败都以文本结果返回，不抛异常。
  */

/** 读取的行数与字符数由上下文窗口份额派生；这里是文件体积上限。 */
export const MAX_FILE_BYTES = 2_000_000;

const DENIED_DIRECTORIES = new Set([".git", "node_modules", ".tutor"]);
/** 模板类 env 文件放行。 */
const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];
/** 按文件名拒读的凭据载体：全小写比较。 */
const DENIED_BASENAMES = new Set([
  // OpenSSH 私钥无扩展名
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
      limit: { type: "integer", description: "读取行数：不给就一次读到单次字符预算为止（整份源码通常装得下）；给数字则按行窗口读。两种情况都受同一份字符预算约束，装不下时首行会说明并给出续读的 offset" }
    },
    required: ["path"]
  }
};

/** read_file 审计记录，无论成败。 */
export interface FileReadRecord {
  path: string;
  /** 本次实际返回的行数，不是请求的行数。 */
  lines?: number;
  /** 本次返回里被隐去的密钥命中数；只记数量。 */
  masked?: number;
  /** 请求的行未全部返回。 */
  truncated: boolean;
  denied: boolean;
  error?: string;
}

export interface ReadFileOutcome {
  /** 工具结果文本：成功为带行号摘录，失败为拒绝说明。 */
  content: string;
  /** 审计信息；拒绝与失败时 path 记原始请求值。 */
  audit: FileReadRecord;
}

/** 同 path 归并成一条：成功优先，其次取实得行数最大，全为拒绝时保留首条。 */
export function dedupeFileReads(records: FileReadRecord[]): FileReadRecord[] {
  const best = new Map<string, FileReadRecord>();
  for (const record of records) {
    const current = best.get(record.path);
    if (!current) {
      best.set(record.path, record);
      continue;
    }
    const better = (current.denied && !record.denied)
      || (!record.denied && !current.denied && (record.lines ?? 0) > (current.lines ?? 0));
    // Map.set 不改变键的首次插入位序。
    if (better) best.set(record.path, record);
  }
  return [...best.values()];
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index).toLowerCase();
}

/** 按名字拒读的名单检查；字面路径与软链接目标共用。 */
function deniedNameReason(base: string): string | undefined {
  const extension = extensionOf(base);
  const isEnvTemplate = ENV_TEMPLATE_SUFFIXES.some((suffix) => base.toLowerCase().endsWith(suffix));
  if ((base.startsWith(".env") || extension === ".env") && !isEnvTemplate) return "环境变量文件可能包含密钥，禁止读取";
  if (DENIED_BASENAMES.has(base.toLowerCase())) return "该文件通常是密钥/凭据载体，不开放读取";
  if (DENIED_EXTENSIONS.has(extension)) return "该文件类型不开放读取";
  return undefined;
}

/** 名单检查的对外入口：只判目录与名字。 */
export function deniedPathReason(relativePath: string): string | undefined {
  const segments = relativePath.split("/");
  if (segments.some((segment) => DENIED_DIRECTORIES.has(segment))) return "该目录不开放读取";
  return deniedNameReason(segments[segments.length - 1] ?? "");
}

/** 只按文件名做名单检查，不含目录规则。 */
export function deniedSecretNameReason(relativePath: string): string | undefined {
  return deniedNameReason(relativePath.replaceAll("\\", "/").split("/").at(-1) ?? "");
}

/** 一次检查路径边界、名字名单与软链接；返回拒绝理由文本。 */
export function pathReadBlock(repositoryPath: string, relativePath: string): string | undefined {
  if (isAbsolute(relativePath) || relativePath.startsWith("~")) return "只允许仓库内相对路径";
  const relative = relativePath.replaceAll("\\", "/");
  const absolute = join(repositoryPath, relative);
  if (!isWithin(repositoryPath, absolute)) return "路径越出仓库范围";
  const nameReason = deniedPathReason(relative);
  if (nameReason) return nameReason;
  try {
    const realRoot = realpathSync(repositoryPath);
    const real = realpathSync(absolute);
    if (!isWithin(realRoot, real)) return "符号链接指向仓库之外";
    const segments = real.slice(realRoot.length + 1).split("/");
    if (segments.some((segment) => DENIED_DIRECTORIES.has(segment))) return "符号链接指向不开放的目录";
    const targetReason = deniedNameReason(segments[segments.length - 1] ?? "");
    return targetReason ? `符号链接指向禁读文件：${targetReason}` : undefined;
  } catch {
    // 链接目标解析失败时不在这里拒绝，由后续读取本身报错。
    return undefined;
  }
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
  // 抬头与审计行用归一化路径，与索引里的 path 同形。
  const relative = rawPath.replaceAll("\\", "/");
  const blocked = pathReadBlock(repoPath, rawPath);
  if (blocked) return deny(blocked);
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return deny("不是普通文件（目录、命名管道或设备节点）");
    if (stat.size > MAX_FILE_BYTES) return deny(`文件过大（${stat.size} 字节）`);
    const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
    const offset = Math.max(1, Math.floor(Number(args.offset ?? 1) || 1));
    const budgetChars = contextShare(CONTEXT_SHARE.fileRead);
    const budgetLines = contextShareLines(CONTEXT_SHARE.fileRead);
    const wanted = args.limit === undefined ? budgetLines : Math.max(1, Math.floor(Number(args.limit) || 1));
    const limit = Math.min(budgetLines, wanted);
    const start = Math.min(offset, Math.max(1, lines.length));
    const requestedEnd = Math.min(lines.length, start - 1 + limit);
    // 逐行装入字符预算，不拆行。
    const kept: string[] = [];
    let used = 0;
    for (let index = start - 1; index < requestedEnd; index += 1) {
      const rendered = `${index + 1}| ${lines[index]}`;
      if (kept.length && used + rendered.length + 1 > budgetChars) break;
      kept.push(rendered);
      used += rendered.length + 1;
    }
    // 单行本身超预算时按字符切。
    let numbered = kept.join("\n");
    const cutMidLine = numbered.length > budgetChars;
    if (cutMidLine) numbered = numbered.slice(0, budgetChars);
    const end = start + kept.length - 1;
    const truncated = end < requestedEnd || cutMidLine;
    const total = end < lines.length ? `，共 ${lines.length} 行` : "";
    const hint = truncated ? `，已达单次读取预算${cutMidLine ? `（第 ${end} 行本身超长，只给到开头，整行读不全）` : ""}，继续读请用 offset=${end + 1}` : "";
    // 隐去的密钥数量必须写进首行。
    const screened = maskSecrets(numbered);
    const maskedNote = screened.masked ? `，另有 ${screened.masked} 处疑似密钥已隐去（不要尝试补全）` : "";
    const header = `文件 ${relative}（第 ${start}-${end} 行${total}${hint}${maskedNote}）`;
    return { content: `${header}：\n${screened.text}`, audit: { path: relative, lines: kept.length, truncated, denied: false, masked: screened.masked || undefined } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取失败";
    const hint = message.includes("ENOENT") ? "路径不存在；请对照「项目结构全景」里的真实路径拼写重试。" : "";
    return {
      content: `读取 ${rawPath} 失败：${message}${hint ? `（提示：${hint}）` : ""}`,
      audit: { path: rawPath, truncated: false, denied: true, error: message }
    };
  }
}
