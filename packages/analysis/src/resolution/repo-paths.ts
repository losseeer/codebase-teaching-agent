/** join/normalize 的结果统一成仓库口径的正斜杠路径（win32 下返回反斜杠）。 */
export function slash(candidate: string): string {
  return candidate.replaceAll("\\", "/");
}
