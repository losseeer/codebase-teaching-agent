# `agent/` — Agent 持久侧栏

> 单 Agent · 三作用域（map / teaching / practice）独立线程 · 始终在右 · 与 4 路由共享。

## 当前状态（v0.2）

| 文件 | 职责 | 状态 |
|------|------|------|
| `AgentRail.tsx` | 持久右栏外壳：scope-bar + scope-context + agent-thread + composer | ✅ 已实现 |
| `useTeachingSession.ts` | 单一状态源：scope / threads / course / selected / session / settings / liveAnswer（被 AgentRail + TutorPage 共享） | ✅ 已实现 |

## 设计依据

- 开发计划 §1.5「界面基线」第 3 条：Agent 侧栏始终在右，与工作区无关
- 设计文档 ch8「三条界面约束」：
  - 位置/状态变化**不再**用分隔线（v0.8.1 移除 thread-divider）：改由 `.scope-context` 绑定行展示，线程只留对话
  - 教学反馈/提问/判分用气泡（message.user / message.agent）—— 已实现
  - 「判分反馈」明确 in-place + 气泡双轨—— 待 v0.3 在 practice 作用域接入

## v0.2 实现的 4 段（与 prototype `design-prototype.html` 对照）

| 段 | prototype 选择器 | 当前实现 |
|----|------------------|----------|
| 头部 | `.agent-header` | avatar `✦` + 「Codebase Agent」+ 副标题 |
| 作用域切换 | `.scope-bar` / `.scope-chip` | 3 个按钮（map/teaching/practice），active 态深底+亮绿字 |
| 作用域上下文 | `.scope-context` | 「作用域 / 绑定 / 可见 / 动作」4 行；可见动态绑定 |
| 会话条 | `.session-bar` | 当前作用域独立的一份会话清单：下拉切换 + 新建 / 重命名（行内输入，Enter 确认、Esc 取消）/ 删除（二次确认） |
| 线程 | `.agent-thread` + `.message` | 滚动消息列表，按作用域渲染当前线程；发送中显示过程提示（`.agent-progress`，见下） |
| Composer | `.composer` | textarea + 发送；按作用域切换 placeholder + canSend + onSend |

## 过程提示与风格回显（v0.8.1）

- **过程提示**：引擎不只在结束时回一坨正文——教学回合进行中会把过程事件发出来，GUI 显示成一行 `.agent-progress`：
  | 作用域 | 通道 | 事件 |
  |--------|------|------|
  | `map` | SSE（`map-chat/stream`） | `{stage:"thinking",round}` / `{stage:"reading",path}` |
  | `teaching` | SSE（`sessions/:id/messages`） | `{stage:"deciding"}` / `{stage:"thinking",round}` / `{stage:"reading",path}` |
  | `practice` | 无（单轮调用，只有出题前的静态文案） | — |
  引擎发结构化事件（`harness` 的 `TeachingProgress`），中文文案由 `teachingProgressText()` 决定——两侧不互相猜。
- **语言风格回显**：滑块值 + 档位名（严肃/中性/通俗）实时显示；档位判据是 `@codebase-tutor/shared` 的 `styleBand`，
  engine 的 `policyFor` 与 GUI 回显共用同一份阈值（历史坑：harness 曾写死 `>= 65` 与 policy 的 67 不一致）。

## 会话持久化（2026-09-28 起：真源在引擎，不在浏览器）

三作用域的会话正文落在被学习仓的 `chat_session` + `chat_message`（`<repo>/.tutor/tutor.db`），GUI 只攥着 threadId：

- **读写路径**：`GET /api/repositories/:id/threads?scope=` 拉清单，`GET /api/threads/:id/messages` 拉正文；
  发消息时请求体只带 `threadId`（外加选择态），**历史正文与「更早的问题脉络」由引擎自己从库里取**——GUI 不再回传窗口。
- **teaching 特殊**：会话 id 就是 threadId（`POST /api/sessions` 直接以该 id 落 `chat_session`），
  阶段/兜底计数等续命状态在 `state_json` 列里；切到别的课程节点时按节点找回线程，找不回就清空。
- **localStorage** 只剩指针：`codebase-tutor.teaching-sessions` = `repositoryId → {teach|map|practice → {currentId, ids[]}}`，
  旧形状（`仓库:节点 → sessionId`）当空表忽略。删掉的线程会从 `ids` 里剪掉。
- **删除是软删**：列表与正文从此看不见，库里的消息行和 journal 的审计事件都留着，所以二次确认文案必须写明这点。
- **practice 换题 = 换线程**：旧的 `practiceHistoryStart` 游标 hack 已删，换题直接切到新线程，跨题污染无从发生。

## 作用域语义

| Scope | label | bound | visible | 动作 |
|-------|-------|-------|---------|------|
| `map` | 宏观设计 | 课程根节点 | 课程 / 文件树 / 模块关系 | 只读 |
| `teaching` | 代码教学 | 当前选中节点 | 源码 / 锚点 / `stage <session.stage>` | 可写入 session（真发 LLM） |
| `practice` | 练习评估 | 当前练习 | 题目 / 答案 / 进度 | v0.3 接入判分写入学习日志 |

## v0.2 已落地的 prototype 目标

- ✅ Agent 侧栏始终在右（grid 第三列）
- ✅ 三作用域独立线程（threads `Record<Scope, ThreadItem[]>`）
- ✅ scope chips（map/teaching/practice）
- ✅ 切换作用域只切线程与绑定（不再插「已切换到 · xxx」）
- ✅ 切换课程节点只更新会话与绑定（不再插「已切换到 / 已打开」）
- ✅ 持久化：会话正文在引擎库，localStorage 只存每作用域的 threadId 指针（见上节）

## v0.3+ 待办

- 接入 practice 作用域判分气泡（in-place + 气泡双轨）
- 过程提示接入 practice 作用域（需要在单轮调用前后补事件，否则该作用域仍只有静态文案）

（原「接入 map 作用域 LLM」「把 CoursePage / PracticePage 的选择并入 hook」两条已落地：map 对话走 `map-chat/stream`，
三页共用 `useTeachingSession` 的 `setMapNode / setMapFile / setPracticeUnit`。）

## 重构对比 v0.1 → v0.2

| 维度 | v0.1 | v0.2 |
|------|------|------|
| Chat 位置 | TutorPage 内嵌 | AgentRail（teaching 作用域） |
| Composer | TutorPage 内嵌 | AgentRail（teaching 真发，其他作用域草稿） |
| 流式订阅（session.delta）| TutorPage useEffect | AgentRail useEffect（共享 hook） |
| 跨工作区共享 Agent | ❌ | ✅（同一 workspace 下，所有路由共享 thread + scope） |
| 持久化 | workspace | workspace + scope + 会话指针（正文在引擎 `chat_message`） |