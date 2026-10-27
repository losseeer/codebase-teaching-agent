/**
  一次外部工具调用的审计形状（`mcp_call` 事件的 payload）。
  放在共享内核而不是 MCP 客户端里：记这笔账的有三处——客户端自己、回合收尾、中止回合的补记，
  一处定义才能保住那条口径：**正文不进任何日志**，只记字符数与指纹（与 `code_egress` 同一处置）。
*/
export interface McpCallAudit {
  server: string;
  tool: string;
  /** 发给 server 的参数：只记字符数与指纹，正文不落盘。 */
  argsChars: number;
  argsHash: string;
  /** 交回模型的字符数（密钥筛与上限裁完之后）。 */
  resultChars: number;
  /** 密钥筛隐去了几处。`0` = 扫过零命中，与「没扫」是两个读数。 */
  masked: number;
  ok: boolean;
  ms: number;
  error?: string;
}
