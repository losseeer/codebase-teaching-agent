# `scope/` — 作用域可见范围（Scope Visibility）

> 单一 Agent 在三个作用域里各自维护一条独立对话线程；切换作用域只改变**可见工具与上下文**，不切到另一个 Agent。

## 当前状态

**v0.1（设计已固化，实现未抽离）**：作用域仅体现在路由切换（`/course` = 宏观设计、`/tutor` = 代码教学、`/practice` = 练习评估）。`SCOPES` 配置（可见工具 / 默认 placeholder / 自我介绍 reply）当前没在前端维护——prototype 中体现，GUI 中未实现。

prototype `design-prototype.html` 第 496-500 行：
```js
const SCOPES = {
  map: { label: '宏观设计', view: 'map', sees: ['依赖图', '流程节点', '文件树', '语义检索'],
         placeholder: '讨论这个项目的宏观设计…',
         reply: '我会停在宏观作用域：只引用结构、边界和调用关系，不展开单行实现。' },
  teaching: { label: '代码教学', view: 'teaching', sees: ['仓库文件', '源码锚点', '调用图', '教学模块'],
              placeholder: '针对当前文件与行号提问…',
              reply: '我会围绕当前源码锚点推进，每一步都引用具体文件和行号。' },
  practice: { label: '练习评估', view: 'practice', sees: ['练习模块', '实现单元', '证据', '评分标准'],
              placeholder: '对这道练习追问…',
              reply: '我只给线索、不代答，并引用证据和评分标准。' }
};
```

## v0.2+ 抽离目标

| 文件 | 职责 |
|---|---|
| `scopes.ts` | `SCOPES` 常量（label / view / sees / placeholder / reply） |
| `useScope.ts` | hook：当前作用域 + 切换副作用（与 prototype `setScope()` 1:1） |
| `ScopeContext.tsx` | 上下文卡（prototype `.scope-context`：作用域 · 绑定 · 可见 · 动作）|
| `index.ts` | 公共 API barrel |

## 设计文档对齐

`codebase-teaching-agent.html` 第 8 章 §作用域 × 可见范围 × 典型提示：

| 作用域 | 默认可见 | 位置/状态变化的展示位置（v0.8.1 起） | 触发的 Agent 气泡 |
|---|---|---|---|
| 宏观设计 | 依赖图 / 流程节点 / README 摘要 / 入口文件 | `.scope-context` 绑定行（节点 + 文件），不入线程 | 宏观结构与上下游 |
| 代码教学 | 当前源码 tab / 课程树 / 苏格拉底状态机上下文 | `.scope-context` 绑定行（标题 + `file:line`），不入线程 | 苏格拉底式提问与回退 |
| 练习评估 | 评分标准 / 提示阶梯 / 历史错题 / ZPD 校准 | `.scope-context` 绑定行（练习单元 + `file:line`），不入线程 | 判分反馈 + 下一题建议 |

## 与引擎 harness 对接

作用域可见范围最终由 engine `harness/assembleContext()` 按当前 scope 过滤工具与上下文（`@codebase-tutor/engine`）——前端只负责 UI 表达（chip + placeholder + reply 模板），不重复实现可见性逻辑。