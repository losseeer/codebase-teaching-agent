/** 表级约束行，不是列声明：整行跳过。 */
const TABLE_CONSTRAINT = /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i;

/** 声明文本 → 每张表的列清单，语句边界取到第一个 `;`。 */
export function declaredColumns(schema: string): { table: string; column: string; declaration: string }[] {
  const clean = schema.replace(/--[^\n]*/g, "");
  const out: { table: string; column: string; declaration: string }[] = [];
  for (const match of clean.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([^;]*)\)\s*;/g)) {
    const table = match[1];
    for (const entry of splitTopLevel(match[2])) {
      const declaration = entry.trim().replace(/\s+/g, " ");
      if (!declaration || TABLE_CONSTRAINT.test(declaration)) continue;
      out.push({ table, column: declaration.split(" ")[0], declaration });
    }
  }
  return out;
}

/** 按顶层逗号切列声明：`PRIMARY KEY(a, b)` 里面的逗号不算分隔。 */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}
