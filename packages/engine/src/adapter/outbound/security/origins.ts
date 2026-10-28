/** 来源闸：判定请求 Origin 是否可信。 */

export function configuredOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TUTOR_ALLOWED_ORIGINS ?? "").split(/[,\s]+/).map((entry) => normalizeOrigin(entry)).filter((entry) => entry !== "");
}

/** 只信无 Origin 的调用、回环来源与清单内来源。 */
export function isTrustedOrigin(origin: string | undefined, configured: string[] = configuredOrigins()): boolean {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  // Origin 为 "null" 的是无源页面
  if (!normalized || normalized === "null") return false;
  if (configured.includes(normalized)) return true;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

/** 归一化来源：大小写与尾斜杠不参与比较。 */
function normalizeOrigin(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}
