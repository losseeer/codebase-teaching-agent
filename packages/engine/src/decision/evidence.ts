import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionUnit, Evidence, FileEntry, SourceAnchor } from "@codebase-tutor/shared";
import { hash } from "../lib.js";

const configNames = ["tsconfig.json", "vite.config.ts", "vite.config.js", "eslint.config.js", ".eslintrc", "pyproject.toml", "requirements.txt", "docker-compose.yml"];

export function collectDecisionUnits(repositoryPath: string, files: FileEntry[]): DecisionUnit[] {
  const decisions: DecisionUnit[] = [];
  const manifestPath = join(repositoryPath, "package.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
      const manifestText = readFileSync(manifestPath, "utf8");
      for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).slice(0, 30)) {
        decisions.push(decisionForPackage(name, version, manifestText));
      }
      for (const [name, command] of Object.entries(manifest.scripts ?? {}).slice(0, 10)) {
        decisions.push({
          id: `decision:script:${name}`,
          title: `运行入口：${name}`,
          claim: `仓库通过 \`${name}\` 脚本执行 \`${command}\`。`,
          summary: "脚本声明了可重复执行的开发、构建或测试入口；它不说明选型动机。",
          evidence: [sourceEvidence("package_manifest", "direct", `package.json scripts.${name}: ${command}`, { path: "package.json", line: lineOf(manifestText, `"${name}"`), label: "脚本定义" })],
          confidence: "direct",
          anchors: [{ path: "package.json", line: lineOf(manifestText, `"${name}"`), label: "脚本定义" }],
          verification: []
        });
      }
    } catch { /* A malformed manifest is simply absent evidence. */ }
  }
  for (const name of configNames) {
    const path = join(repositoryPath, name);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    decisions.push({
      id: `decision:config:${name}`,
      title: `配置：${name}`,
      claim: `仓库包含 ${name}，其配置参与构建或运行行为。`,
      summary: "配置文件是直接存在的证据，但仅凭它不能断言作者为什么做出此选择。",
      evidence: [sourceEvidence("config", "direct", content.slice(0, 280), { path: name, line: 1, label: "配置文件" })],
      confidence: "direct",
      anchors: [{ path: name, line: 1, label: "配置文件" }],
      verification: []
    });
  }
  const readme = files.find((file) => /^readme\.md$/i.test(file.path));
  if (readme) decisions.push(...readmeEvidence(repositoryPath, readme.path));
  decisions.push(...commitEvidence(repositoryPath));
  return uniqueById(decisions).slice(0, 50);
}

function decisionForPackage(name: string, version: string, manifest: string): DecisionUnit {
  const line = lineOf(manifest, `"${name}"`);
  const anchor = { path: "package.json", line, label: "依赖声明" };
  return {
    id: `decision:package:${name}`,
    title: `依赖：${name}`,
    claim: `仓库声明使用 ${name}@${version}。`,
    summary: `这是直接的依赖声明。该声明证明“正在使用”，不单独证明“为何选择”；若 README 或提交信息没有说明，动机保持待确认。`,
    evidence: [sourceEvidence("package_manifest", "direct", `"${name}": "${version}"`, anchor)],
    confidence: "direct",
    anchors: [anchor],
    verification: []
  };
}

function readmeEvidence(repositoryPath: string, path: string): DecisionUnit[] {
  const content = readFileSync(join(repositoryPath, path), "utf8");
  return content.split("\n").map((line, index) => ({ line, index })).filter(({ line }) => /(?:because|why|选择|采用|based on|built with)/i.test(line)).slice(0, 8).map(({ line, index }) => {
    const anchor = { path, line: index + 1, label: "README 说明" };
    return {
      id: `decision:readme:${hash(line).slice(0, 10)}`,
      title: "README 选型说明",
      claim: line.trim(),
      summary: "README 是作者面对用户的说明，能作为间接的选型线索，仍需与源码或提交历史交叉核对。",
      evidence: [sourceEvidence("readme", "indirect", line.trim(), anchor)],
      confidence: "indirect" as const,
      anchors: [anchor],
      verification: []
    };
  });
}

function commitEvidence(repositoryPath: string): DecisionUnit[] {
  try {
    const output = execFileSync("git", ["-C", repositoryPath, "log", "-n", "30", "--pretty=format:%h%x09%s"], { encoding: "utf8", timeout: 1_000 });
    return output.split("\n").filter((line) => /(?:add|adopt|migrate|switch|选择|迁移|引入)/i.test(line)).slice(0, 8).map((line) => ({
      id: `decision:commit:${hash(line).slice(0, 10)}`,
      title: "提交历史线索",
      claim: `提交信息：${line}`,
      summary: "提交信息是间接线索；除非变更内容和讨论可复核，不能把它当作完整的选型理由。",
      evidence: [{ id: `evidence:${hash(line).slice(0, 10)}`, source: "git_commit", strength: "indirect", excerpt: line }],
      confidence: "indirect" as const,
      anchors: [],
      verification: []
    }));
  } catch {
    return [];
  }
}

function sourceEvidence(source: Evidence["source"], strength: Evidence["strength"], excerpt: string, anchor: SourceAnchor): Evidence {
  return { id: `evidence:${hash(`${source}:${excerpt}:${anchor.path}:${anchor.line}`).slice(0, 12)}`, source, strength, excerpt, anchor };
}

function lineOf(content: string, text: string): number {
  const position = content.indexOf(text);
  return position < 0 ? 1 : content.slice(0, position).split("\n").length;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
