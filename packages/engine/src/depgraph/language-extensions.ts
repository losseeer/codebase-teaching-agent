import { extname } from "node:path";
import { LANGUAGE_CAPABILITIES, languageOfExtension } from "@codebase-tutor/shared";

/**
  图认哪些扩展名 = 能力表各条目的 `extensions` 汇总，不在这里另抄一份清单。
  */
export const graphExtensions: readonly string[] = [...new Set(Object.values(LANGUAGE_CAPABILITIES).flatMap((entry) => entry.extensions))];
/**
  建图时真正的那道后缀闸门（`buildDependencyGraph` 与语言画像共用）。
  它区分大小写，这是刻意不收紧的已知局限：`.TS` 这类大写后缀在图这一层一致排除，
  单点改成小写匹配只会造出「符号按 TS 语法解析、边却连不出来」的半状态。
  它与索引层的闸门不是一条：索引器先 lowercase 再比，所以 `App.TS` 进得了索引清单、进不了图。
  语言画像必须按这道闸门报数，否则会把「进了索引、没进图」说成「都在图里」。
  */
export const handledExtensions = new Set(graphExtensions);

/**
  裸说明符（TS 的 `./util`、`./util.js`）允许落到哪些扩展名：按发起文件的语言收尾。
  拿全表 19 个扩展名挨个试的话，同目录里 TS 的 `./util` 能连到 `util.py`、`util.go`，
  而能力表给 typescript 的 `dependencyEdge: exact` 就不再成立。
  收尾后 `typescript` / `vue` 一族互连（SFC 的 `<script>` 里 `./util` 落的就是 `.ts`），其余语言各自只试自己的扩展名。
  */
const SCRIPT_FAMILY = ["typescript", "vue"] as const;

/** ES/CJS/JSX 的后缀各对应哪份 TS 源文件（NodeNext 的固定对子）。 */
export const nodeNextTargets: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts", ".d.mts"],
  ".cjs": [".cts", ".d.cts"]
};

/**
  「按 TypeScript 那一族的写法处理」的判据，取自能力表而不是手写正则（手写会漏 `.mts`/`.cts`）。
  这一族不含 `.vue`：回落抽出的符号因此标成 `other` 而不是伪装成 typescript，也不给 `.vue` 探 TS 语言服务。
  不含它不意味着回落时 `.vue` 不被那条 JS/TS 正则扫：SFC 的 `<script>` 块里扫得出的都是真符号
  （模板里的 `{{ }}` 撞不上 `function`/`const … =>`/`class` 三种形状）。
  刻意不收紧成「非本族就不抽符号」：那样 wasm 一挂，`.vue`/`.java` 连回落符号都没有，比标错语言更糟。
  */
export const tsFamilyExtensions = new Set(LANGUAGE_CAPABILITIES.typescript.extensions);

export function specifierExtensions(fromPath: string): readonly string[] {
  const language = languageOfExtension(extname(fromPath));
  if (!language) return [];
  if (language === "typescript" || language === "vue") return SCRIPT_FAMILY.flatMap((entry) => LANGUAGE_CAPABILITIES[entry].extensions);
  return LANGUAGE_CAPABILITIES[language].extensions;
}

/** C/C++ 一族的扩展名（cpp 语法同时覆盖纯 C）。 */
export const cppExtensionPattern = /\.(c|h|cc|cpp|cxx|hpp|hh)$/;

/** TS/JS 的说明符一律带引号；Python 与 Java 的 import 没有引号，各走 extractPythonSpecifiers / extractJavaSpecifiers。 */
export const tsSpecifierPattern = /(?:from\s+|import\s*\(?\s*|require\s*\()\s*["']([^"']+)["']/g;
