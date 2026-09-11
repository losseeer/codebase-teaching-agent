# `journal/` — 事件发射（UI → journal.jsonl）

> 所有 UI 操作必须有 `journal.jsonl` 事件可查——可观测性是设计文档第 8 章的三条界面约束之一（"可观测"）。

## 当前状态

**v0.1（未发射）**：前端所有交互（开文件 / 切模块 / 切 workspace / 判分 / 调节风格等）当前**不发射 journal 事件**。引擎端的 journal.jsonl 只记录学习事件（`unit_mastered` / `exercise_result` / `hint_depth` 等），不记录 UI 动作。

这是设计文档已固化但前端未落地的契约：

`codebase-teaching-agent.html` 第 8 章 §界面 × 数据契约：

| 工作区 | 读 | 写（journal 事件）| 不做 |
|---|---|---|---|
| 课程地图 | 依赖图、目录索引、流程节点 | `flow_node_selected` · `file_anchored` | 不写 LLM 调用 |
| 教学会话 | 源码 tab、课程树锚点、阶梯状态 | `file_opened` · `line_located` · `hint_depth` | 不直接改源码、不写 style_shift |
| 练习复习 | 题目实例、评分标准、ZPD | `module_switched` · `exercise_submitted` · `exercise_result` | 不替代用户答、判分不开恩 |

`开发计划.md` §9 事件 schema：周 3 冻结 v1（append-only 兼容）。

## v0.2+ 实现目标

| 文件 | 职责 |
|---|---|
| `emit.ts` | 通用 emit 函数：`emit(eventType, payload)`，自动加 `at` / `repositoryId` / `sessionId` |
| `events.ts` | 9 类 UI 事件类型常量：`flow_node_selected` / `file_anchored` / `file_opened` / `line_located` / `module_switched` / `exercise_submitted` / `exercise_result` / `hint_depth` / `style_shift` |
| `transport.ts` | 传输通道：v0.2 走 POST `/api/.../journal`；v0.3+ 可改 WebSocket 批量 |
| `index.ts` | 公共 API barrel |

## 接入点（v0.2 任务）

- `views/CoursePage.tsx`：节点选中 → `flow_node_selected`；锚点点击 → `file_anchored`
- `views/TutorPage.tsx`：风格滑杆变化 → `style_shift`；课程节点切换 → `line_located`
- `views/PracticePage.tsx`：模块切换 → `module_switched`；提交答案 → `exercise_submitted`（引擎端已发，前端可发 UI 端 `hint_depth`）
- `views/ImportPage.tsx`：仓库导入完成 → `repository_switched`（新增）

## 关键约束

- **append-only**：事件发出后不修改、不删除；下游消费方做聚合
- **at 时间戳**：客户端本地时间 + ISO 8601；引擎端按 server 时间为最终时间
- **payload 类型**：仅允许 `string | number | boolean | null`（避免结构化对象随版本漂移）
- **失败容错**：网络失败时入 localStorage 重试队列，避免 UI 操作不可观测