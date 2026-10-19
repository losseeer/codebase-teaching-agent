import type { DeclaredType, FactSkip, SymbolInfo, TypeRelationEdge, TypeRelationFileFact, TypeRelationKind } from "@codebase-tutor/shared";
import type { SyntaxNode } from "../depgraph/parser.js";
import { FACTS_VERSION } from "./version.js";

/**
  类型之间的关系：谁继承谁、谁实现谁、字段指向哪个类型、泛型实参是谁、方法收什么返回什么。
  与依赖图里那三条边（`dispatch`）分开放——那边是为「把实现类接回执行流」服务的，只到文件为止；
  这边要的是类型名级别的全貌。

  两条如实交代：
  - **落点靠名字反查**（`类型名 → 声明过这个名字的文件`），同名类型可能指错。查到唯一一份才写
    `toFile`；多份写 `ambiguous` 把候选都列出来；查不到就什么都不写——那是仓外类型或标准库，
    不是「这个类型不存在」。
  - 标量与内置类型（`int` / `string` / `error` / `Promise`…）不进这张表。它们不是项目里的类型，
    收进来只会把表灌满噪声；能力表的 `typeRelations` 格写明这条。
*/

const MAX_RELATIONS = 60;

/** 声明了一个具名类型的节点（各语言名字不同，用一张正则表收口）。 */
const DECLARATION = /^(abstract_)?(class|interface|enum|record|struct|trait|union)_(declaration|item|specifier)$|^class_definition$|^type_spec$|^type_alias$|^type_definition$|^type_item$|^struct_specifier$|^class_specifier$|^enum_specifier$|^impl_item$|^impl$|^enum_declaration$/;
/** 一个类型引用长什么样。 */
const TYPE_NODE = /^(type_identifier|qualified_identifier|generic_type|user_type|scoped_type_identifier|named_type|nullable_type|array_type|slice_type|map_type|pointer_type|reference_type|optional_type|function_type|constructor_type|union_type|intersection_type|literal_type|type|abstract_class_modifier)$/;
/**
  语言自带的关键字与原始类型：它们不是项目里的类型，收进来只会把表灌满噪声。
  刻意**区分大小写**并只列关键字：`List` / `Map` / `Order` 都是真实的类型引用
  （`List<Order>` 里那条 `Order` 正是画图要的），它们只是反查不到仓内文件而已——那是 `toFile` 空着的事，
  不该由这张表替读者决定「库类型不算类型」。
*/
const SCALAR = /^(any|unknown|never|void|null|undefined|bool|boolean|byte|sbyte|short|int|integer|long|float|double|decimal|char|rune|string|str|number|object|dynamic|self|Self|this|This|unit|bigint|symbol|error|Error|Exception|Throwable)$/;
/** 类型名本身住在哪里（拿到名字就要停，不再往里当普通类型走）。 */
const NAME_NODE = /^(type_identifier|identifier|field_identifier|name|path|type)$/;

function contextOf(node: SyntaxNode): TypeRelationKind | undefined {
  const type = node.type;
  if (/^type_arguments$/.test(type)) return "generic-argument";
  // 顺序有讲究：Java 的 `super_interfaces` 同时含 super 与 interfaces，先判 extends 就会把它认成继承
  if (/implements|interfaces|base_list|^trait$/.test(type)) return "implements";
  if (/heritage|superclass|extends/.test(type)) return "extends";
  if (/return_type/.test(type)) return "returns";
  if (/parameter|argument_list/.test(type)) return "parameter";
  if (/type_bound/.test(type)) return "extends";
  if (/field_declaration|variable_declarator|variable_declaration|init_declarator|public_field_definition|field_definition|property_signature|ordered_field_declaration_list|equals_value_clause|local_variable_declaration/.test(type)) return "field";
  if (/type_alias|type_spec|type_definition|union_type|intersection_type/.test(type)) return "alias";
  return undefined;
}

/** 一个类型节点的名字：去掉泛型实参与命名空间前缀，只留读者认得的那个名字。 */
function typeNameOf(node: SyntaxNode): string | undefined {
  if (node.type === "generic_type") return node.childForFieldName("type")?.text ?? node.namedChildren.at(0)?.text;
  if (node.type === "user_type") return node.namedChildren.at(-1)?.text;
  const text = node.text.trim();
  const bare = text.split("<")[0].split(".").pop()?.trim();
  return bare && !/\s/.test(bare) ? bare : undefined;
}

function isScalar(name: string): boolean {
  return SCALAR.test(name);
}

/** 这个声明自己带来的类型形参（`<T>`、`<K, V: Clone>`）：它们是占位名，不是指向某个类型的边。 */
function typeParametersOf(node: SyntaxNode): Set<string> {
  const out = new Set<string>();
  const walk = (current: SyntaxNode, depth: number): void => {
    if (depth > 3) return;
    for (const child of current.namedChildren) {
      if (/^type_parameters$|^generic_parameters$/.test(child.type)) {
        for (const param of child.namedChildren) {
          const name = param.childForFieldName("name")?.text.trim() ?? param.namedChildren.at(0)?.text.trim() ?? param.text.trim().split(/[^\w]/)[0];
          if (name) out.add(name);
        }
      }
      walk(child, depth + 1);
    }
  };
  walk(node, 0);
  return out;
}

/** 收集一个声明节点里的类型引用；不钻进嵌套的声明（那是另一个类型的事）。 */
function collectRelations(node: SyntaxNode, declared: string, resolve: (name: string) => { file?: string; ambiguous?: string[] }): TypeRelationEdge[] {
  const params = typeParametersOf(node);
  const edges: TypeRelationEdge[] = [];
  const seen = new Set<string>();
  /** 已经按语境单独处理过的子树（返回类型），不再走一遍通用递归 */
  const handled = new Set<number>();
  const add = (name: string, kind: TypeRelationKind, via: string, at: SyntaxNode): void => {
    if (isScalar(name) || name === declared || params.has(name)) return;
    const line = at.startPosition.row + 1;
    const dedupe = `${kind}:${name}:${line}`;
    if (seen.has(dedupe) || edges.length >= MAX_RELATIONS) return;
    seen.add(dedupe);
    const found = resolve(name);
    edges.push({ to: name, kind, via, line, ...(found.file ? { toFile: found.file } : {}), ...(found.ambiguous?.length ? { ambiguous: found.ambiguous.slice(0, 6) } : {}) });
  };
  const walk = (current: SyntaxNode, context: TypeRelationKind | undefined, depth: number): void => {
    if (depth > 12 || edges.length >= MAX_RELATIONS) return;
    const own = contextOf(current);
    const next = own ?? context;
    // 继承/实现子句里类型名常常直接就是一个 identifier（TS 的 `extends_clause` 就是 identifier + type_arguments），
    // 不是 TYPE_NODE；不认这一层就会整条丢掉 extends。只在**已经站在继承语境里**时认，
    // 否则类名、方法名、变量名全都会被当成类型引用收走。
    if (next && (next === "extends" || next === "implements") && /^(identifier|type_identifier|qualified_identifier|scoped_identifier|path)$/.test(current.type)) {
      const name = typeNameOf(current);
      if (name) add(name, next, current.type, current);
      return;
    }
    // 继承/实现子句里，类型名常常直接就是一个 identifier（TS 的 `extends_clause` 就是 identifier + type_arguments），
    // 不是 TYPE_NODE；不认这一层就会整条丢掉 extends
    if (!TYPE_NODE.test(current.type) && own && (current.type === "identifier" || current.type === "type_identifier" || current.type === "qualified_identifier" || current.type === "path")) {
      const name = typeNameOf(current);
      if (name) add(name, own, current.type, current);
      return;
    }
    // 返回类型：TS 把它挂在 `return_type` 字段上（有时干脆没有字段名），Java/Rust/Go 挂在 `type` 字段上。
    // 不先按字段取出来，就会掉进「没有语境的类型引用」里被丢掉——而「这个方法返回什么类型」
    // 恰恰是画依赖方向时最想要的一格。
    if (FUNCTIONISH.test(current.type)) {
      const returned = current.childForFieldName("return_type") ?? current.childForFieldName("type");
      if (returned) {
        handled.add(returned.id);
        walk(returned, "returns", depth + 1);
      }
    }
    // Rust 的 `impl Trait for Type`：被实现的 trait 挂在 `trait` 字段上，节点名里没有任何
    // implements 字样，不按字段取就会整条丢掉这条实现关系
    if (current.type === "impl_item" || current.type === "impl") {
      const trait = current.childForFieldName("trait");
      if (trait) {
        handled.add(trait.id);
        walk(trait, "implements", depth + 1);
      }
    }
    if (TYPE_NODE.test(current.type)) {
      const name = typeNameOf(current);
      if (name && next) add(name, next, current.type, current);
      if (current.type === "generic_type") {
        const head = current.childForFieldName("type") ?? current.namedChildren.at(0);
        if (head) {
          const headName = typeNameOf(head);
          if (headName && next) add(headName, next, "generic_type", head);
        }
      }
    }
    if (NAME_NODE.test(current.type) && current.parent && TYPE_NODE.test(current.parent.type)) return;
    for (const child of current.namedChildren) {
      if (handled.has(child.id) || DECLARATION.test(child.type) && child.type !== "impl_item") continue;
      walk(child, next, depth + 1);
    }
  };
  walk(node, undefined, 0);
  return edges;
}

const FUNCTIONISH = /^(method_definition|method_declaration|function_declaration|function_item|function_signature_item|method_elem|constructor_declaration|function_definition|method_declarator)$/;

function declarationName(node: SyntaxNode): string | undefined {
  const direct = node.childForFieldName("name")?.text.trim() ?? node.childForFieldName("type")?.text.trim();
  if (direct) return direct.split("<")[0].split(/\s+for\s/)[0].trim();
  const declarator = node.childForFieldName("declarator");
  const inner = declarator?.childForFieldName("declarator") ?? declarator;
  return inner?.text.trim().replace(/[*&\s]/g, "") || undefined;
}

function declarationKind(node: SyntaxNode): DeclaredType["kind"] {
  // Go 的 `type Dog struct {...}` 声明节点叫 type_spec：类型在它的 `type` 字段里，名字本身不透露是结构体还是接口
  const inner = node.childForFieldName("type")?.type ?? "";
  const type = `${node.type} ${inner}`;
  if (/interface/.test(type)) return "interface";
  if (/trait/.test(type)) return "trait";
  if (/struct/.test(type)) return "struct";
  if (/enum/.test(type)) return "enum";
  if (/alias|type_spec|type_definition|type_item/.test(type)) return "alias";
  return "class";
}

/**
  一个文件的类型关系。`allSymbols` 是**整仓**的符号表——落点要靠全仓的「谁声明了这个名字」来反查，
  只看当前文件会把所有跨文件的类型都说成「查不到」。
*/
export function analyzeFileTypes(path: string, root: SyntaxNode, language: string, allSymbols: SymbolInfo[]): TypeRelationFileFact {
  const index = new Map<string, string[]>();
  for (const symbol of allSymbols) {
    if (symbol.kind !== "class" && symbol.kind !== "type") continue;
    const list = index.get(symbol.name) ?? [];
    if (!list.includes(symbol.path)) list.push(symbol.path);
    index.set(symbol.name, list);
  }
  const resolve = (name: string): { file?: string; ambiguous?: string[] } => {
    const list = index.get(name);
    if (!list?.length) return {};
    if (list.length === 1) return { file: list[0] };
    return { ambiguous: list };
  };

  const types: DeclaredType[] = [];
  const skipped: FactSkip[] = [];
  const walk = (node: SyntaxNode, depth: number): void => {
    if (depth > 14 || types.length > 400) return;
    if (DECLARATION.test(node.type)) {
      const name = declarationName(node);
      if (!name) {
        skipped.push({ name: `${node.type}@${node.startPosition.row + 1}`, reason: "声明节点取不出类型名（多为匿名结构体或宏生成），未收进类型关系" });
        return;
      }
      const relations = collectRelations(node, name, resolve);
      types.push({
        name,
        kind: declarationKind(node),
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        relations: relations.sort((left, right) => left.line - right.line),
        ...(relations.length >= MAX_RELATIONS ? { truncated: true } : {})
      });
      // 嵌套声明自己会走一遍，不在父类型里重复收
      for (const child of node.namedChildren) walk(child, depth + 1);
      return;
    }
    for (const child of node.namedChildren) walk(child, depth + 1);
  };
  walk(root, 0);
  return {
    path,
    language,
    backend: "ast",
    version: FACTS_VERSION,
    types: types.sort((left, right) => left.line - right.line),
    ...(skipped.length ? { skipped } : {})
  };
}
