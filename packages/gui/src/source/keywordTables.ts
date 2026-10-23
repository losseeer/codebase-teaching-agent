export const TSJS_KEYWORDS = new Set([
  "abstract", "any", "as", "asserts", "async", "await", "bigint", "boolean", "break", "case", "catch", "class",
  "const", "continue", "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends",
  "false", "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "infer", "instanceof",
  "interface", "is", "keyof", "let", "namespace", "never", "new", "null", "number", "object", "of", "private",
  "protected", "public", "readonly", "return", "satisfies", "set", "static", "string", "super", "switch", "symbol",
  "this", "throw", "true", "try", "type", "typeof", "undefined", "unique", "unknown", "var", "void", "while", "yield"
]);

/** 其他 C 系语言的关键字并集（java / go / rust / c / cpp / c# / php / swift / kotlin / scala）。 */
export const CLIKE_KEYWORDS = new Set([
  "abstract", "as", "async", "auto", "await", "bool", "boolean", "break", "byte", "case", "catch", "char", "class",
  "const", "continue", "crate", "debugger", "default", "defer", "del", "do", "double", "else", "elif", "enum",
  "except", "export", "extends", "extern", "false", "final", "finally", "float", "fn", "for", "foreach", "from",
  "func", "function", "goto", "if", "impl", "implements", "import", "in", "instanceof", "int", "interface", "internal",
  "is", "lambda", "let", "long", "loop", "match", "mod", "mut", "namespace", "native", "new", "nil", "not", "null",
  "or", "override", "package", "pass", "private", "protected", "public", "raise", "readonly", "ref", "register",
  "return", "self", "short", "signed", "sizeof", "static", "struct", "super", "switch", "synchronized", "this",
  "throw", "throws", "trait", "true", "try", "type", "typedef", "typeof", "union", "unsafe", "unsigned", "use",
  "var", "virtual", "void", "volatile", "where", "while", "with", "yield"
]);

export const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield", "match", "case"
]);

export const RUBY_KEYWORDS = new Set([
  "alias", "and", "begin", "break", "case", "class", "def", "do", "else", "elsif", "end", "ensure", "for", "if",
  "in", "module", "next", "nil", "not", "or", "redo", "rescue", "retry", "return", "self", "super", "then", "undef",
  "unless", "until", "when", "while", "yield", "require", "require_relative", "attr_accessor", "attr_reader",
  "attr_writer", "private", "public", "protected"
]);

export const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function",
  "return", "export", "local", "readonly", "declare", "source", "set", "unset", "shift", "trap", "eval", "exit",
  "break", "continue", "true", "false", "null"
]);

export const JSON_LITERALS = new Set(["true", "false", "null"]);

/** 类型位置的引导词：其后的大写标识符按类型着色。 */
export const TYPE_CONTEXT = new Set([
  "new", "class", "extends", "implements", "interface", "type", "enum", "namespace", "is", "as", "keyof", "satisfies"
]);
