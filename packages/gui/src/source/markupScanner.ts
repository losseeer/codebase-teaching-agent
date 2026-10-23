import { type ScanState, type Token } from "./codeToken";
import { createCollector, findStringEnd } from "./scanPrimitives";

// ==== 标记语言（html / xml / vue / svelte）====

export function scanMarkup(line: string, state: ScanState): Token[] {
  const out = createCollector();
  let index = 0;

  if (state.blockComment) {
    const end = line.indexOf("-->");
    if (end < 0) {
      if (line) out.push(line, "cm");
      return out.tokens;
    }
    out.push(line.slice(0, end + 3), "cm");
    state.blockComment = false;
    index = end + 3;
  }

  let insideTag = false;
  while (index < line.length) {
    const rest = line.slice(index);

    if (rest.startsWith("<!--")) {
      const end = line.indexOf("-->", index + 4);
      if (end < 0) {
        out.push(rest, "cm");
        state.blockComment = true;
        return out.tokens;
      }
      out.push(line.slice(index, end + 3), "cm");
      index = end + 3;
      continue;
    }

    const char = rest[0];

    if (char === "<") {
      const tag = /^(?:<\/?[A-Za-z][A-Za-z0-9.:-]*|<\/?>|<!\[CDATA\[)/.exec(rest);
      if (tag) {
        out.push(tag[0], "tag");
        index += tag[0].length;
        insideTag = true;
        continue;
      }
    }

    if (char === ">" && insideTag) {
      out.push(">", "tag");
      insideTag = false;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const [end] = findStringEnd(line, index, char);
      out.push(line.slice(index, end), "str");
      index = end;
      continue;
    }

    if (insideTag) {
      const attribute = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(rest);
      if (attribute) {
        out.push(attribute[0], "prop");
        index += attribute[0].length;
        continue;
      }
      if (char === "=") {
        out.push("=", "op");
        index += 1;
        continue;
      }
    }

    out.plain(char);
    index += 1;
  }
  out.flush();
  return out.tokens;
}
