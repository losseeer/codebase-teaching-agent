/** 「只打控制台、不落盘」的取值表：`llm.log` 与 `engine.jsonl` 两条线共用，不各写一份。 */
const LOG_DISABLED = new Set(["off", "none", "0", "false"]);

/**
  日志落点解析：环境变量没给 → 用默认文件；给了 `LOG_DISABLED` 之一 → `null`（只打控制台）；否则当路径用。
  每次现读 `process.env` 而不是模块级缓存，测试才能各自把落点指到临时文件。
 */
export function logTargetFromEnv(raw: string | undefined, defaultFile: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return defaultFile;
  return LOG_DISABLED.has(value.toLowerCase()) ? null : value;
}
