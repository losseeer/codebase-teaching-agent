/** 来源闸的判据只这一处：CORS 与拒绝都问这个函数。 */

/** 可信来源清单：env `TUTOR_ALLOWED_ORIGINS` 逗号或空格分隔，逐项去尾斜杠、转小写后精确匹配。 */
export function configuredOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TUTOR_ALLOWED_ORIGINS ?? "").split(/[,\s]+/).map((entry) => normalizeOrigin(entry)).filter((entry) => entry !== "");
}

/** 只信无 Origin 的调用、回环来源与清单内来源；不带 Origin 的本机调用同样放行。 */
export function isTrustedOrigin(origin: string | undefined, configured: string[] = configuredOrigins()): boolean {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized || normalized === "null") return false; // file:// 之类的页面是「无源」，不当成本机
  if (configured.includes(normalized)) return true;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, ""); // IPv6 写出来是 [::1]
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

/** 统一成小写、去尾斜杠：`https://A.com:3000/` 与 `https://a.com:3000` 是同一个来源。 */
function normalizeOrigin(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}
