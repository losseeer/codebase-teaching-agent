# `scope/` — 作用域可见范围（Scope Visibility）

> 单一 Agent 在三个作用域里各自维护一条独立对话线程；切换作用域只改变**可见工具与上下文**，不切到另一个 Agent。
> 本目录只是设计说明，实现代码不在这里。

## 当前实现在哪

| 关注点 | 落点 |
|---|---|
| 作用域清单与中文标签（`map` / `teaching` / `practice`） | `agent/useScopedChat.ts` 的 `SCOPES`、`SCOPE_LABEL`、`progressText` |
| 按作用域切换输入框提示与发送动作 | `agent/AgentRail.tsx` 的 `composerForScope`（三个作用域都走引擎 SSE 流式 + 打字机回放） |
| 绑定行（当前作用域绑的是节点 / 文件 / 环节 / 练习） | `agent/AgentRail.tsx` 的 `ScopeContext` + `boundFor` |
| GUI 作用域名 ↔ 引擎作用域名的换算 | `useScopedChat.ts` 的 `CHAT_SCOPE`（`teaching` → `teach`） |
| 真正决定「这一轮模型能看见什么、能用哪些工具」 | 引擎侧：教学走 `harness/context.ts` 的 `assembleContext` + `harness/harness.ts` 的工具循环；宏观/练习走 `scopechat/scopechat.ts` |

作用域是**路由内的一层状态**，不是三条路由：`/app?workspace=map|teaching|practice` 切的是工作区视图，
`/course` `/tutor` `/practice` 只留作跳转。切作用域不卸载线程，三条线程各自独立存在。

## prototype 对照（`design-prototype.html` 第 496-500 行）

`SCOPES` 里的 `sees` 在 prototype 是一句中文清单，产品里改由引擎按 scope 过滤工具与上下文——
**前端不重复实现可见性判据**，只呈现 chip、placeholder、绑定行这三样 UI 表达。
`reply`（「我会停在宏观作用域…」那句自我介绍）从未实现，位置/状态变化也不再以分割线入线程（v0.8.1）。

## 设计文档对齐

`codebase-teaching-agent.html` 第 8 章 §作用域 × 可见范围 × 典型提示：

| 作用域 | 默认可见 | 位置/状态变化的展示位置（v0.8.1 起） | 触发的 Agent 气泡 |
|---|---|---|---|
| 宏观设计 | 分层全景 / 流程节点 / README 摘要 / 入口文件 | `.scope-context` 绑定行（节点 + 文件），不入线程 | 宏观结构与上下游 |
| 代码教学 | 当前源码 tab / 课程树 / 锚点摘录与调用邻接（2026-10-14 撤掉状态机后没有阶段与阶梯上下文） | `.scope-context` 绑定行（标题 + `file:line`），不入线程 | 直接回答，可按需读码 |
| 练习评估 | 评分标准 / 历史错题 / ZPD 校准（提示阶梯随状态机一并撤除） | `.scope-context` 绑定行（练习单元 + `file:line`），不入线程 | 判分反馈 + 下一题建议 |

其中「练习评估不提供 `read_file`」是硬约束（`source/read-file.ts` 顶部说明）：它会绕过「判分答案与锚点不进上下文」的防泄题边界。
