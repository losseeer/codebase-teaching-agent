import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isWithin } from "./files.js";
import { maskSecrets } from "../security/secrets.js";
import { CONTEXT_SHARE, contextShare, contextShareLines } from "../llm/context-window.js";
import type { LlmTool } from "../llm/provider.js";

/**
  read_file 工具（宏观设计 map 与教学 teaching 两个作用域共用）：让模型按需拉取源码，
  补足「结构全景/调用邻接 + 锚点摘录」之外的深度。练习答疑作用域不提供该工具——
  它会绕过「判分答案与锚点不进上下文」的防泄题约束。

  护栏（全部强制，非可选项）：
  1. 路径必须落在仓库内，绝对路径与穿越一律拒绝，链接目标再按 realpath 复核一次；
  2. 拒读名单：环境变量文件（模板类除外）、密钥与凭据载体、.git / node_modules / .tutor 目录、二进制后缀；
  3. 单次窗口上限（行数与字符数），字符数是真正的闸：超预算就少给整行，首行写实得区间与续读 offset；
  4. 一切拒绝与失败都以文本结果返回给模型（可自行改参数重试），不抛异常中断对话。

  ⚠️ 名单按文件名判定，挡得住「.env / 私钥文件」这类约定位置，挡不住把口令写进配置正文的情况——
  那是内容判定，不在本模块职责内。
  */

/*
  单次读取的预算从上下文窗口按份额派生（`llm/context-window.ts` 是唯一真源），这里不再手填字符数。
  `MAX_FILE_BYTES` 是进程级安全阀，与上下文预算无关：它挡的是「一次 readFileSync 把内存打死」，
  所以窗口调到多大它都不跟着长。
*/
export const MAX_FILE_BYTES = 2_000_000;

const DENIED_DIRECTORIES = new Set([".git", "node_modules", ".tutor"]);
/** 模板类 env 文件只列键名、不含密钥，而且是理解配置的入口 → 放行。 */
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
      limit: { type: "integer", description: "读取行数：不给就一次读到单次字符预算为止（整份源码通常装得下）；给数字则按行窗口读。两种情况都受同一份字符预算约束，装不下时首行会说明并给出续读的 offset" }
    },
    required: ["path"]
  }
};

/** read_file 审计记录（无论成败；由调用方逐条记 journal file_read）。 */
export interface FileReadRecord {
  path: string;
  /** 本次实际返回的行数，不是请求的行数。 */
  lines?: number;
  /** 本次返回里被隐去的密钥形态命中数（0 = 扫过且干净）；只记数量，原文不进任何日志。 */
  masked?: number;
  /** 请求的行没给全（被字符预算截住，或某一行本身就超预算被切）。首行说明实得区间与续读 offset。 */
  truncated: boolean;
  denied: boolean;
  error?: string;
}

export interface ReadFileOutcome {
  /** 直接回送入模型的内容（成功=带行号摘录，失败=拒绝/错误说明）。 */
  content: string;
  /** 审计信息；拒绝与失败时 path 仍尽量记录原始请求值。 */
  audit: FileReadRecord;
}

/**
  journal 落盘前的归并：同 path 留一条——成功优先于拒绝；同为成功取实得行数最大的一条；
  全为拒绝保留首条（错误原因不丢）；顺序保持首次出现。
*/
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
    if (better) best.set(record.path, record); // Map 保留键的首次插入位序
  }
  return [...best.values()];
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index).toLowerCase();
}

/**
  名字层面的拒绝判据（.env 两头查、无扩展名的凭据载体、密钥/二进制后缀）；返回拒绝理由，`undefined` = 放行。
  字面路径与软链接的目标共用这一份：链接名干净不代表内容干净（`docs/note.md -> ../../.env`）。
  */
function deniedNameReason(base: string): string | undefined {
  const extension = extensionOf(base);
  // 前缀挡住 .env/.env.local，后缀挡住 prod.env/local.env 这类写法
  const isEnvTemplate = ENV_TEMPLATE_SUFFIXES.some((suffix) => base.toLowerCase().endsWith(suffix));
  if ((base.startsWith(".env") || extension === ".env") && !isEnvTemplate) return "环境变量文件可能包含密钥，禁止读取";
  if (DENIED_BASENAMES.has(base.toLowerCase())) return "该文件通常是密钥/凭据载体，不开放读取";
  if (DENIED_EXTENSIONS.has(extension)) return "该文件类型不开放读取";
  return undefined;
}

/**
  名单判据的对外一份：HTTP 侧（`GET /source`）与工具侧（`read_file`）必须同一口径。
  这里只判目录与名字；软链接复核归 `pathReadBlock` 那条路（界面给不出链接目标的路径）。
  */
export function deniedPathReason(relativePath: string): string | undefined {
  const segments = relativePath.split("/");
  if (segments.some((segment) => DENIED_DIRECTORIES.has(segment))) return "该目录不开放读取";
  return deniedNameReason(segments[segments.length - 1] ?? "");
}

/**
  只判名字那一半（不含目录规则）的对外读数，给索引层：读层拒读的文件不该进收录集。
  目录那一半刻意留在外面——`.tutorignore` 已经管住 `.git/`、`node_modules/`，
  而用户显式反排除 `.tutor` 时索引层照办是既有设计（`ignore.test.ts` 钉着）。
  */
export function deniedSecretNameReason(relativePath: string): string | undefined {
  return deniedNameReason(relativePath.replaceAll("\\", "/").split("/").at(-1) ?? "");
}

/**
  「这个仓内路径到底能不能给原文」——边界、名字名单、软链接三关一次判完的对外一份，
  工具侧（`read_file`）与 HTTP 侧（`GET /source`）共用，两条口径不许各写一遍。
  软链接那一关是必需的：前两道判的是字面路径，而 `fs` 读的是解析后的目标。
  返回 `undefined` 表示放行；返回的那句直接给调用方（界面 / 模型）看。
  */
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
    // 链接目标的名字再过一遍同一份判据（指到 `.env`、指到 `credentials.json` 都算绕过）
    const targetReason = deniedNameReason(segments[segments.length - 1] ?? "");
    return targetReason ? `符号链接指向禁读文件：${targetReason}` : undefined;
  } catch {
    // 链接目标解析不出来（文件已删、链接断了、权限不够）不在这里判：这一层只管政策，
    // 「读不出来」交给调用方那层的 try 如实说，免得把「文件不存在」说成「我不给读」
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
  // 下面那句抬头与审计行都用归一化后的路径（`\` 换成 `/`），审计线才与索引里的 path 同形
  const relative = rawPath.replaceAll("\\", "/");
  const blocked = pathReadBlock(repoPath, rawPath);
  if (blocked) return deny(blocked);
  try {
    const stat = statSync(absolute);
    // 只读普通文件：命名管道与设备节点的同步读没有 EOF，一次就把整个单线程引擎冻住（不抛异常，下面的 catch 兜不住）
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
    // 逐行装进字符预算：宁可少给几行，也不把一行切一半 —— 否则首行那句「第 X-Y 行」就不成立，
    // 模型会以为自己看到了没给它的行。
    const kept: string[] = [];
    let used = 0;
    for (let index = start - 1; index < requestedEnd; index += 1) {
      const rendered = `${index + 1}| ${lines[index]}`;
      if (kept.length && used + rendered.length + 1 > budgetChars) break;
      kept.push(rendered);
      used += rendered.length + 1;
    }
    // 极端情况：单行本身就超预算（压缩过的 JS/JSON）→ 只能按字符切，并在首行说明该行只给了前半段
    let numbered = kept.join("\n");
    const cutMidLine = numbered.length > budgetChars;
    if (cutMidLine) numbered = numbered.slice(0, budgetChars);
    const end = start + kept.length - 1;
    const truncated = end < requestedEnd || cutMidLine;
    const total = end < lines.length ? `，共 ${lines.length} 行` : "";
    /**
      续读建议一律指向 `end + 1`：单行被字符上限切开时，那一行的后半段永远给不出来（下一次同样只拿到前半段），
      把 offset 指回它自己等于建议模型原地转圈。
      */
    const hint = truncated ? `，已达单次读取预算${cutMidLine ? `（第 ${end} 行本身超长，只给到开头，整行读不全）` : ""}，继续读请用 offset=${end + 1}` : "";
    /**
      入口这道过筛：正文要进发往远端的 prompt，硬编码在普通源文件里的真 key 是名单挡不住的（它叫 `config.ts`）。
      首行必须说明「这里被隐去了 N 处」——不写的话模型会以为文件本来就少了几段，
      于是去猜那段密钥、或者对用户说「输出被截断」。
    */
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
