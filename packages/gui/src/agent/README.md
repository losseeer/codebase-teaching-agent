# `agent/` — Agent 侧栏

> 共享 Agent 侧栏（作用域 / 线程 / 上下文卡 / composer）。始终在右，与工作区无关。

## 当前状态

**v0.1（已部分实现）**：当前只有 `CompanionDock.tsx`（伴侣建议面板），由 App 在 workspace 存在时挂载。

**未实现**：prototype 中核心的 Agent 侧栏（composer + thread + scope chips + scope context 卡）当前**只在 prototype 中可见**，GUI 路由切换模式让 composer 嵌入了 `views/TutorPage.tsx` 而非共享。

## 与 prototype 的差异（关键缺口）

| 维度 | prototype（v5） | 当前 GUI |
|---|---|---|
| 工作区 | 三工作区共享主区（map / teaching / practice 互切）| 4 路由（course / tutor / practice / insights） |
| Agent 侧栏 | **始终在右**，三作用域独立线程 | 仅 TutorPage 自带 composer；伴侣面板另起 aside |
| 作用域 chips | Agent 侧栏顶部 | 没有 chip；作用域靠路由切换 |
| 线程 | map/teaching/practice 三线程独立 | 仅 TutorPage 单线程 |
| Composer | 共享主区右侧 Agent 栏 | TutorPage 内嵌 |

## v0.2+ 抽离目标

| 文件 | 职责 |
|---|---|
| `AgentRail.tsx` | 侧栏外壳（右侧 322px 宽，sticky） |
| `ScopeChips.tsx` | 三个作用域 chips（宏观设计 / 代码教学 / 练习评估） |
| `ScopeContext.tsx` | 作用域上下文卡（绑定 / 可见 / 动作） |
| `Thread.tsx` | 三作用域独立线程渲染（prototype `renderThread()` 1:1） |
| `Composer.tsx` | composer 文本框 + 发送 + 占位符按作用域切换 |
| `pushMessage.ts` / `pushDivider.ts` | prototype 中同名函数抽离版；系统通知 / Agent 气泡 / 分隔线分发 |
| `CompanionDock.tsx` | ✅ 已实现（伴侣建议，与三作用域独立线程解耦） |

## 设计文档

`codebase-teaching-agent.html` 第 8 章：
- §三条界面约束："提示样式二选一"——位置/状态变化用分隔线，教学反馈/提问/判分用气泡
- §作用域 × 可见范围 × 典型提示：每个作用域的默认可见 + 触发的分隔线 + 触发的 Agent 气泡

## 重构入口

`views/TutorPage.tsx` 第 90-110 行的 composer 当前内嵌；抽出后：
- TutorPage 只保留会话控制（风格 / 教学法 / 拆解层次 / 阶梯 / 锚点 / 成本）
- Chat 渲染与 composer 移到 `agent/Thread.tsx` + `agent/Composer.tsx`
- App.tsx 把 AgentRail 挂到右侧（仿照 CompanionDock 的挂载方式）