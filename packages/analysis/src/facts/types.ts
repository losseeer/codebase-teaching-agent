import type { DeclaredType, FactSkip, SymbolInfo, TypeRelationEdge, TypeRelationFileFact, TypeRelationKind } from "@codebase-tutor/domain";

import type { SyntaxNode } from "../extraction/parser.js";
import { FACTS_VERSION } from "./version.js";

/**
  类型之间的关系：继承、实现、字段类型、泛型实参、方法参数与返回类型。
  与依赖图的 `dispatch` 边分开放：那边到文件为止，这边到类型名。
  落点靠名字全仓反查：唯一命中写 `toFile`，多份写 `ambiguous`，查不到不写。
*/

const MAX_RELATIONS = 60;

/** 声明具名类型的节点类型。 */
const DECLARATION = /^(abstract_)?(class|interface|enum|record|struct|trait|union)_(declaration|item|specifier)$|^class_definition$|^type_spec$|^type_alias$|^type_definition$|^type_item$|^struct_specifier$|^class_specifier$|^enum_specifier$|^impl_item$|^impl$|^enum_declaration$/;
const TYPE_NODE = /^(type_identifier|qualified_identifier|generic_type|user_type|scoped_type_identifier|named_type|nullable_type|array_type|slice_type|map_type|pointer_type|reference_type|optional_type|function_type|constructor_type|union_type|intersection_type|literal_type|type|abstract_class_modifier)$/;
/** 语言关键字与原始类型，不计为类型引用。匹配区分大小写。 */
const SCALAR = /^(any|unknown|never|void|null|undefined|bool|boolean|byte|sbyte|short|int|integer|long|float|double|decimal|char|rune|string|str|number|object|dynamic|self|Self|this|This|unit|bigint|symbol|error|Error|Exception|Throwable)$/;
/** 类型名所在的节点：取到名字即停，不再深入。 */
const NAME_NODE = /^(type_identifier|identifier|field_identifier|name|path|type)$/;

function contextOf(node: SyntaxNode): TypeRelationKind | undefined {
  const type = node.type;
  if (/^type_arguments$/.test(type)) return "generic-argument";
  // Java 的 super_interfaces 同时含 extends 与 interfaces，implements 须先判
  if (/implements|interfaces|base_list|^trait$/.test(type)) return "implements";
  if (/heritage|superclass|extends/.test(type)) return "extends";
  if (/return_type/.test(type)) return "returns";
  if (/parameter|argument_list/.test(type)) return "parameter";
  if (/type_bound/.test(type)) return "extends";
  if (/field_declaration|variable_declarator|variable_declaration|init_declarator|public_field_definition|field_definition|property_signature|ordered_field_declaration_list|equals_value_clause|local_variable_declaration/.test(type)) return "field";
  if (/type_alias|type_spec|type_definition|union_type|intersection_type/.test(type)) return "alias";
  return undefined;
}

/** 类型节点的名字：去掉泛型实参与命名空间前缀。 */
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

/** 声明自带的类型形参：占位名，不成边。 */
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

/** 收集声明节点内的类型引用，不进入嵌套声明。 */
function collectRelations(node: SyntaxNode, declared: string, resolve: (name: string) => { file?: string; ambiguous?: string[] }): TypeRelationEdge[] {
  const params = typeParametersOf(node);
  const edges: TypeRelationEdge[] = [];
  const seen = new Set<string>();
  /** 已按字段处理过的子树，不再走通用递归。 */
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
    // 继承/实现子句的类型名常是 identifier 而非 TYPE_NODE，只在继承语境里认
    if (next && (next === "extends" || next === "implements") && /^(identifier|type_identifier|qualified_identifier|scoped_identifier|path)$/.test(current.type)) {
      const name = typeNameOf(current);
      if (name) add(name, next, current.type, current);
      return;
    }
    if (!TYPE_NODE.test(current.type) && own && (current.type === "identifier" || current.type === "type_identifier" || current.type === "qualified_identifier" || current.type === "path")) {
      const name = typeNameOf(current);
      if (name) add(name, own, current.type, current);
      return;
    }
    // 返回类型：TS 挂 return_type 字段，Java/Rust/Go 挂 type 字段
    if (FUNCTIONISH.test(current.type)) {
      const returned = current.childForFieldName("return_type") ?? current.childForFieldName("type");
      if (returned) {
        handled.add(returned.id);
        walk(returned, "returns", depth + 1);
      }
    }
    // Rust 的 impl：trait 挂在 trait 字段，节点名不含 implements
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
  // Go 的 `type Dog struct {...}` 声明节点叫 type_spec：类型在 type 字段里，名字本身不透露是结构体还是接口
  const inner = node.childForFieldName("type")?.type ?? "";
  const type = `${node.type} ${inner}`;
  if (/interface/.test(type)) return "interface";
  if (/trait/.test(type)) return "trait";
  if (/struct/.test(type)) return "struct";
  if (/enum/.test(type)) return "enum";
  if (/alias|type_spec|type_definition|type_item/.test(type)) return "alias";
  return "class";
}

/** 一个文件的类型关系；`allSymbols` 须为整仓符号表，落点靠全仓反查。 */
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
      // 嵌套声明由各自遍历处理，不在父类型里重复收
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

