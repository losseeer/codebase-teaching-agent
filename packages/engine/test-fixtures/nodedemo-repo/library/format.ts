// 负例：纯工具模块，没有框架 import，也没有任何登记。
export const money = (value: number): string => value.toFixed(2);
