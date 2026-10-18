const fs = require("node:fs");

/** 报出「导入了但正文里一次都没出现」的名字（本仓 tsc 没开 noUnusedLocals，这类东西不会自己红）。 */
for (const file of process.argv.slice(2)) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const body = lines.filter((line) => !/^import /.test(line)).join("\n");
  const names = [];
  for (const line of lines.filter((entry) => /^import /.test(entry))) {
    const braces = line.match(/\{([^}]*)\}/);
    if (!braces) continue;
    for (const part of braces[1].split(",")) {
      const name = part.trim().replace(/^type /, "").split(" as ").pop();
      if (name) names.push(name);
    }
  }
  const unused = [...new Set(names)].filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
  console.log(`${file.split("/").pop()} 未使用的导入：${unused.join(", ") || "（无）"}`);
}
