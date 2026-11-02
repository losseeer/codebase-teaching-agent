import { execFile } from "node:child_process";
import { traceEngine } from "@codebase-tutor/platform";

/**
  本机目录选择：调系统原生窗口，只在导入页由用户手动触发。
  打不开就返回可读原因，界面保留手输路径作为兜底。
*/

export type DirectoryPickResult =
  | { ok: true; path: string }
  | { ok: false; reason: "canceled" | "unavailable" | "failed"; message?: string };

export type CommandRunner = (command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

/** 用户可能把窗口开着去翻目录，超时只防进程永远挂着。 */
const PICKER_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER = 64 * 1024;

function systemRunner(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: PICKER_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BUFFER, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function errorText(error: unknown): string {
  const record = error as { stderr?: unknown; message?: unknown };
  return `${typeof record.stderr === "string" ? record.stderr : ""}\n${typeof record.message === "string" ? record.message : ""}`.trim();
}

function errorCode(error: unknown): string | number | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function missingCommand(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** osascript 取消时以 1 退出，stderr 带 -128。 */
function appleCanceled(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return text.includes("-128") || text.includes("user canceled") || text.includes("user cancelled") || text.includes("取消");
}

function cleanPosix(raw: string): string {
  const text = raw.replace(/[\r\n]+$/, "");
  if (!text) return "";
  return text === "/" ? "/" : text.replace(/\/+$/, "");
}

function cleanWindows(raw: string): string {
  return raw.replace(/[\r\n]+$/, "");
}

function unavailable(platform: NodeJS.Platform, detail?: string): DirectoryPickResult {
  traceEngine("degrade", { what: "folder_picker_unavailable", platform, ...(detail ? { detail } : {}) });
  return { ok: false, reason: "unavailable", message: "这台机器没有可用的目录选择窗口，请手动输入路径。" };
}

function failed(error: unknown, platform: NodeJS.Platform): DirectoryPickResult {
  traceEngine("degrade", { what: "folder_picker_failed", platform, reason: errorText(error).slice(0, 300) });
  return { ok: false, reason: "failed", message: "目录选择窗口打不开，可以手动输入路径。" };
}

async function pickMac(run: CommandRunner): Promise<DirectoryPickResult> {
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-e", 'POSIX path of (choose folder with prompt "选择要导入的代码仓库")']);
    const path = cleanPosix(stdout);
    return path ? { ok: true, path } : { ok: false, reason: "canceled" };
  } catch (error) {
    if (appleCanceled(error)) return { ok: false, reason: "canceled" };
    if (missingCommand(error)) return unavailable("darwin");
    return failed(error, "darwin");
  }
}

async function pickLinux(run: CommandRunner): Promise<DirectoryPickResult> {
  try {
    const { stdout } = await run("zenity", ["--file-selection", "--directory", "--title=选择要导入的代码仓库"]);
    const path = cleanPosix(stdout);
    return path ? { ok: true, path } : { ok: false, reason: "canceled" };
  } catch (error) {
    // zenity 取消时退出码 1 且不写 stderr；有 stderr 就是真失败。
    if (errorCode(error) === 1 && !errorText(error)) return { ok: false, reason: "canceled" };
    if (!missingCommand(error)) return failed(error, "linux");
  }
  try {
    const { stdout } = await run("kdialog", ["--getexistingdirectory", process.env.HOME ?? ".", "--title", "选择要导入的代码仓库"]);
    const path = cleanPosix(stdout);
    return path ? { ok: true, path } : { ok: false, reason: "canceled" };
  } catch (error) {
    if (errorCode(error) === 1 && !errorText(error)) return { ok: false, reason: "canceled" };
    if (missingCommand(error)) return unavailable("linux", "zenity 与 kdialog 都不在 PATH 上");
    return failed(error, "linux");
  }
}

async function pickWindows(run: CommandRunner): Promise<DirectoryPickResult> {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
    "$d.Description = '选择要导入的代码仓库';",
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }"
  ].join(" ");
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", script]);
    const path = cleanWindows(stdout);
    return path ? { ok: true, path } : { ok: false, reason: "canceled" };
  } catch (error) {
    if (missingCommand(error)) return unavailable("win32");
    return failed(error, "win32");
  }
}

function pickFor(platform: NodeJS.Platform, run: CommandRunner): Promise<DirectoryPickResult> {
  if (platform === "darwin") return pickMac(run);
  if (platform === "win32") return pickWindows(run);
  if (platform === "linux") return pickLinux(run);
  return Promise.resolve(unavailable(platform));
}

/** 同一时刻只开一个选择窗口；第二个调用等同一份结果。 */
let inFlight: Promise<DirectoryPickResult> | undefined;

export function pickLocalDirectory(options: { platform?: NodeJS.Platform; run?: CommandRunner } = {}): Promise<DirectoryPickResult> {
  if (inFlight) return inFlight;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? systemRunner;
  inFlight = pickFor(platform, run).finally(() => { inFlight = undefined; });
  return inFlight;
}
