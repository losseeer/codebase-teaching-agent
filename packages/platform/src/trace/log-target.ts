/** 「只打控制台」的取值；llm.log 与 engine.jsonl 共用。 */
const LOG_DISABLED = new Set(["off", "none", "0", "false"]);

/** 日志落点解析：env 未给用默认文件，禁用值返回 null，否则当路径；每次现读 env。 */
export function logTargetFromEnv(raw: string | undefined, defaultFile: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return defaultFile;
  return LOG_DISABLED.has(value.toLowerCase()) ? null : value;
}
