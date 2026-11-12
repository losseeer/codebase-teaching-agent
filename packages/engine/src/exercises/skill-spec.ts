/** 技能文件的公共规范：frontmatter 解析、名称与描述上限；加载与校验共用，避免口径漂移。 */

export const DESCRIPTION_MAX = 1024;
/** 正文与 Markdown 附属文件的字符上限；与运行时读取共用同一口径。 */
export const PAYLOAD_CHARS = 12_000;
export const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+?)\s*$/.exec(line);
    if (entry && !fields[entry[1]]) fields[entry[1]] = entry[2];
  }
  return fields;
}
