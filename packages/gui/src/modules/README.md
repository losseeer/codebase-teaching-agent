# `modules/` — 知识模块（Knowledge Modules）

> 教学与练习共享同一组模块 chips。缺省四模块（计算机网络 / 操作系统 / 语言特性 / 其他计算机知识）由 `DEFAULT_MODULES` 提供；用户可逐行改名 / 新增 / 删除 / 恢复缺省。

## 当前状态

**v0.1（已对齐 prototype，但未抽离）**：知识模块逻辑当前内嵌在 `views/TutorPage.tsx` 与 `views/PracticePage.tsx` 中——直接调 `api.getLearner(...)` 拿推荐档，未在前端维护 chips 状态。

prototype `design-prototype.html` 是 v0.1 唯一可交互基线，其中：
- 教学会话左栏：`教学模块 chips + 推荐入口（带 file:line）+ 仓库文件树`
- 练习复习左栏：`模块 chips + 该模块下四类练习`
- 模块配置内联编辑器：`＋ 配置` chip 触发，逐行改名 / 删除 / 新增 / 恢复缺省
- 模块切换只更新绑定行与线程归属：v0.8.1 起不再往线程插 `模块 · A → B` 分隔线（design doc §8 已同步）

## v0.2+ 抽离目标

本目录最终应包含：

| 文件 | 职责 |
|---|---|
| `defaults.ts` | 缺省四模块 `DEFAULT_MODULES = [network, os, lang, other]` 常量 |
| `useModuleConfig.ts` | 通用 hook：模块列表 + 当前选中 + 配置面板开关 |
| `ModuleChips.tsx` | chips 渲染 + 点击切换 |
| `ModuleConfig.tsx` | `＋ 配置` 触发的内联编辑器 |
| `index.ts` | 公共 API barrel |

## 与 prototype 对齐

prototype 的对应章节（`design-prototype.html` 第 313-340 行）：
```js
const DEFAULT_MODULES = [
  { id: 'network', label: '计算机网络', hint: 'HTTP 入口、超时、重试与幂等' },
  { id: 'os', label: '操作系统', hint: '进程内状态、IO 边界与并发' },
  { id: 'lang', label: '语言特性', hint: '类型收窄、异步编排与错误处理' },
  { id: 'other', label: '其他计算机知识', hint: '分层架构、存储与一致性' }
];
```

**设计文档** `codebase-teaching-agent.html` 第 8 章 §知识模块可配置：模块可配置 + 缺省四模块表 + 引导文案空态。

**校招叙事**：用户可配 + 缺省 = 「承认经验多样性」的设计姿态，比硬编码 4 模块更扛反例。