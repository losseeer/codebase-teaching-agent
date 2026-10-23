/** token 类别：对应 global.css 里的样式类（.kw / .fn / .str / .cm / .num / .type / .prop / .op / .tag）。 */
export type TokenKind =
  | "plain"
  | "kw" // 关键字
  | "str" // 字符串 / 模板串
  | "cm" // 注释
  | "num" // 数字 / 字面量
  | "fn" // 函数与方法调用
  | "type" // 类型名 / 类名 / 选择器
  | "prop" // 属性访问 / 对象键 / 属性名
  | "op" // 运算符
  | "tag"; // 标记语言标签名

export interface Token {
  text: string;
  kind: TokenKind;
}

/** 跨行扫描状态（按行顺序传递）。 */
export interface ScanState {
  blockComment: boolean;
  quote: string | null;
  fence: boolean;
}
