/**
  来源闸（企业化第 5 条：默认形态的暴露面）。
  判据只有这一处：CORS 回不回 `access-control-allow-origin`、以及要不要当场拒掉，都问这一个函数。
  */

/** 可信来源清单：env `TUTOR_ALLOWED_ORIGINS` 逗号或空格分隔，逐项去尾斜杠、转小写后**精确匹配**。 */
export function configuredOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TUTOR_ALLOWED_ORIGINS ?? "").split(/[,\s]+/).map((entry) => normalizeOrigin(entry)).filter((entry) => entry !== "");
}

/**
  这个来源能不能信。默认只信两类：
  ① **没有 Origin 头的调用方**——curl、进程间调用，以及浏览器里的同源请求（GUI 走相对路径就属这类）；
  ② **回环来源**——`http(s)://localhost|127.0.0.1|::1:<任意端口>`（vite dev 在 :3000、引擎在 :3001 属这类）。
  其余一律不信。理由：引擎只监听 127.0.0.1，但**浏览器里任意网页照样能把请求打到这个地址**——
  发请求不需要跨域权限，只需要读得到响应；而旧写法 `origin: true` 正好把响应递给它。
  ⚠️ 这一道是**来源**闸，只管浏览器里的页面能不能碰这台引擎，不是认证：本机进程、别的本机用户、
  任何不带 Origin 的客户端都走得通这一道——但他们仍然过不了口令那道（`api-keys.ts`：真实监听的进程开机就配发一张，
  2026-10-15 拍板「本机调用也得带 token」）。按人按仓授权也仍然在那张 key 上，三者不互相顶替。
  */
export function isTrustedOrigin(origin: string | undefined, configured: string[] = configuredOrigins()): boolean {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized || normalized === "null") return false; // file:// 之类的页面就是「无源」，不当成本机
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
