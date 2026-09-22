# `journal/` — 事件发射（UI → journal.jsonl）

> 所有 UI 操作必须有 `journal.jsonl` 事件可查——可观测性是设计文档第 8 章的三条界面约束之一（"可观测"）：
> 「每一次切节点、打开文件、切换模块、提交练习，都必须有 `journal.jsonl` 事件可查——缺事件的 UI 操作是设计漏洞。」

## 当前状态

**已落地**（2026-09-17）：本模块由 `emit.ts` / `events.ts` / `transport.ts` / `index.ts` 组成，
四个工作区已接入，事件经 `POST /api/repositories/:id/journal` 写入该仓库的 `.tutor/journal.jsonl`。

此前（v0.1）前端不发射任何 journal 事件、引擎端只记学习事件；那段「契约已固化但未落地」的状态已经结束。

## 事件 schema（就地冻结）

对齐 `@codebase-tutor/shared` 的 `JournalEventType`。**append-only**：只许新增取值，不许改名或删除既有取值。

| 工作区 | 读 | 写（journal 事件） | 不做 |
|---|---|---|---|
| 宏观设计 | 依赖图、目录索引、流程节点 | `flow_node_selected` · `file_anchored` | 不写 LLM 调用 |
| 代码教学 | 源码 tab、课程树锚点、阶梯状态 | `file_opened` · `line_located` · `hint_depth` · `entry_adopted` · `entry_overridden` | 不直接改源码、不写 `style_shift` |
| 练习评估 | 题目实例、评分标准、ZPD | `exercise_generated`（引擎送达） · `exercise_submitted` · `exercise_result` | 不替代用户答、判分不开恩 |
| 导入仓库 | 导入任务与预估 | `repository_switched` | 不在导入中写学习事件 |

### 两条边界（易混，写在这里免得再踩）

1. **`style_shift` 由引擎写，前端不发射。** 契约表「不做」列已点名；引擎在两处写它
   （`session_created` 与 `manual`），前端再写一遍就是同一事实双写、必然漂移。
   此处与早前「接入点」清单里的 `TutorPage: 风格滑杆 → style_shift` 冲突，**以契约表为准**。
2. **引擎侧事件前端不得发射**：`unit_mastered` / `hint_depth` / `dependency_event` / `action_veto` /
   `token_usage` / `file_read` / `unassisted_test` / `exercise_result` / `exercise_declined` /
   `exercise_generated` / `turn_text`
   都由引擎在状态机、工具循环与成本核算里写。前端只写「用户做了什么」，不写「引擎得出了什么」。
   `exercise_submitted`（用户提交）与 `exercise_result`（判分结果）是两件事，各写各的。
   `turn_text`（2026-09-22 口径）是「消息全文不落盘」红线的重新谈判结果：三种对话（teach / map_chat /
   practice_chat）的问题+回复双边进 journal，各截 2000 字带 `*_truncated` 留痕，永久追加、无 TTL 无开关——
   它是 B 档第 2/3 刀（教学法不变量机检、表达质量裁判）的被测输入源，只能由引擎写。

### 字段与约束

| 字段 | 约束 |
|---|---|
| `type` | 必须在 `JournalEventType` 白名单内；引擎侧 `Journal.append` 用**运行时** Set 校验，越界抛错 |
| `at` | 引擎按 server 时间写成 ISO 8601；客户端时间只是参考，不参与排序 |
| `repositoryId` | 由 URL 路径决定（引擎自己填），前端不传 |
| `sessionId` | 可选。**不做存在性校验**——`sessions` 是引擎进程内存态，重启后旧 id 查不到；按外键拒绝会让前端每次重启后都写不进事件 |
| `traceId` | 引擎从请求上下文自动填，前端不用管 |
| `payload` | 仅允许 `string \| number \| boolean \| null`（避免结构化对象随版本漂移）；单个字符串 ≤ 2000 字符 |

### 按工作区的接入点

| 文件 | 触发 | 事件 |
|---|---|---|
| `views/CoursePage.tsx` | 点模块节点 / 流程环节 | `flow_node_selected`（`view` 区分 architecture / flow） |
| `views/CoursePage.tsx` | 点目录文件 / 锚点 / 流程环节里的文件 | `file_anchored`（`source` 区分 tree / anchor / flow） |
| `views/TutorPage.tsx` | 打开一个没开过的文件 | `file_opened` |
| `views/TutorPage.tsx` | 已开过的文件换行定位（含切节点带过来的自动定位） | `line_located` |
| `views/TutorPage.tsx` | 点推荐入口且真的换绑选中节点（`source` 区分 llm/回落） | `entry_adopted` |
| `views/TutorPage.tsx` | 推荐列表展示中手动打开不在清单里的文件（树/⌘P；口径「开文件即改选」） | `entry_overridden` |
| `views/PracticePage.tsx` | 切换练习模块（id 未变不记） | `module_switched` |
| `views/PracticePage.tsx` | 提交答案（判分结果由引擎记 `exercise_result`） | `exercise_submitted` |
| `views/ImportPage.tsx` | 导入完成、工作区切换（只记一次） | `repository_switched` |

## 关键约束

- **append-only**：事件发出后不修改、不删除；下游消费方做聚合。
- **失败容错**：网络失败或非 2xx 先 `console.warn`，再入 localStorage 重试队列
  （`codebase-tutor.journal-retry`，上限 50 条）；`installJournalRetry()` 在 App 启动时补发并订阅 `online`。
  丢了必须看得见——静默丢弃等于把「设计漏洞」藏起来。
- **未挂载仓库时不静默丢弃**：`emit` 打 warning 说明事件未记录。
- **重复渲染不等于重复操作**：完成态可能被轮询/广播反复渲染，因此工作区切换用 ref 只记一次。
- **effect 触发的发射要去重**：`StrictMode` 下 effect 在首挂载会双跑（点击处理器不会），
  同一个 UI 动作会被记成两条。`TutorPage` 的自动定位用 `lastAutoAnchor` ref 挡住同一锚点连发——
  注意 `openedPaths` 是在 `setTabs` 的 updater 里更新的，两次调用之间它还是空的，
  所以「新开文件 / 就地定位」的判定挡不住这条路，必须在 effect 层去重。

## 相关

- 引擎侧实现：`packages/engine/src/store/journal.ts`（白名单 + append）、
  `packages/engine/src/server.ts` 里的 `POST /api/repositories/:repositoryId/journal`。
- 引擎自身的工作日志在别处：`~/.codebase-tutor/engine.jsonl`（请求 / 导入 / 重分析 / 降级 / 启动）
  与 `~/.codebase-tutor/llm.log`（LLM 调用明细），两者靠 `traceId` 与 journal 关联——
  对话语义与引擎健康分开记，互不依赖。
