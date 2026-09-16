# Codebase Tutor

本地优先的代码库教学 Agent。导入一个真实仓库后，引擎会建立文件与 Git 热点索引、生成带源码锚点的课程树与运行路径地图，并围绕「宏观设计 / 代码教学 / 练习评估」三作用域提供常驻 Agent 侧栏。所有分析结果、SQLite 数据库和不可变学习日志（journal）都保存在被导入仓库的 `.tutor/` 目录——你的代码不出本机。

## 项目简介

- **宏观设计**：左侧「项目目录」按真实目录分组展示（可折叠、带语义标签），右侧「运行路径」画布由课程节点自动布局，支持拖拽平移、缩放与节点详情抽屉，每个节点可溯源到源码锚点。
- **代码教学**：左侧「教学模块」由知识模块 chips + LLM 推荐入口 + 仓库文件树组成；右侧为实时源码（多 tab、⌘P 快速搜索）。Agent 侧栏以「受限 agent loop」驱动教学对话：每轮 LLM 从固定动作菜单（推进 / 降脚手架 / 给答案 / 确认）提议动作，状态机守门校验教学法不变量（熔断前置、verify 阶段确认门禁），否决后回落确定性路径；上下文注入锚点附近真实源码摘录与完整近史，全程 journal 可审计。
- **练习评估**：练习围绕配置的知识模块（计算机网络 / 操作系统 / 语言特性等，可自定义）组织，按模块从当前仓库筛选出题目标，题型为输出预测 / 变更定位 / 影响分析，由受限执行与集合匹配自动判分，并按 SM-2 算法调度复习。
- **成本监控**：Token 用量统计、月度预算设置，触顶后 LLM 调用自动降级为本地规则路径。

## 技术选型

| 层 | 选型 |
|---|---|
| **engine** | Fastify v5（REST + WebSocket 流式）、better-sqlite3（双 ABI 原生绑定）、typescript-language-server（LSP 语义增强）、tsx 开发运行时 |
| **gui** | Vite 6 + React 19 + react-router-dom v7 + lucide-react |
| **shared** | 前后端共享 TypeScript 类型（workspace 内直接引用源码） |
| **LLM** | 多 Provider 抽象（OpenAI / OpenAI 兼容端点如 DeepSeek / Anthropic / Ollama）；重量级 / 轻量级两档配置，轻量档未配置时回落主力档；教学对话默认受限 agent loop（`TUTOR_AGENT_LOOP=off` 退回纯工作流） |
| **工具链** | pnpm 10 workspace + turbo + changesets；vitest + Playwright（`e2e/`）；TypeScript 5.8；concurrently 双进程开发 |

## 仓库结构

```
.
├── packages/
│   ├── engine/                  # 分析与教学引擎（Fastify API，:3001）
│   │   └── src/
│   │       ├── server.ts        #   全部 REST 路由 + WebSocket 广播 + 启动计时
│   │       ├── importer/        #   仓库导入：路径归一化、分析编排、增量重分析
│   │       ├── indexer/         #   文件树 / Git 热点索引（热点同样过滤 .tutorignore）、文件变更监听
│   │       ├── summarizer/      #   分层文件摘要（LLM 或本地启发式 + 缓存）
│   │       ├── coursetree/      #   课程树构建、LLM 命名完善（llm-refine）、
│   │       │                    #   模块推荐入口（entry-suggest）、节点投影
│   │       ├── depgraph/        #   依赖图构建 / 影响面分析
│   │       ├── implementation/  #   微观实现单元抽取（函数级）
│   │       ├── lsp/             #   typescript-language-server 语义增强
│   │       ├── quality/         #   分析结果校验（verifyAnalysis）
│   │       ├── harness/         #   教学回复编排（上下文组装 + 动作守门 + LLM 措辞 + 降级）
│   │       ├── teaching/        #   教学状态机：阶段转移（orient→…→confirmed）、意图分类
│   │       │                    #   （正则 / LLM 单轮）、动作菜单提议 + 守门校验（agent loop）
│   │       ├── policy/          #   教学设置（风格/教学法/层次）与校验
│   │       ├── exercises/       #   练习生成、判分、LLM 题面润色、SM-2 复习
│   │       ├── learner/         #   学习者画像 / 掌握度 / 渐隐提示
│   │       ├── companion/       #   IDE 伴侣建议（Claude Code post-tool-use hook）
│   │       ├── hooks/           #   teach-moment 事件过滤
│   │       ├── cost/            #   token 用量汇总与月度预算
│   │       ├── llm/             #   多 Provider LLM 抽象（重试 / 故障转移）
│   │       ├── store/           #   better-sqlite3 封装 + journal（JSONL 日志）
│   │       ├── scripts/         #   phase0 研究脚本（prepare-study / audit）
│   │       └── lib.ts           #   hash / id / 路径工具
│   ├── gui/                     # 前端（Vite dev server，:3000，/api 代理到 engine）
│   │   ├── public/              #   design-prototype.html（界面基线）+ 截图
│   │   └── src/
│   │       ├── App.tsx          #   shell + 侧栏导航 + 单主区 Workbench
│   │       ├── views/           #   宏观设计 / 代码教学 / 练习评估 / 导入 / 成本监控
│   │       ├── agent/           #   持久 Agent 侧栏 + useTeachingSession 状态源
│   │       ├── map/             #   FlowMap 运行路径画布（自动布局 / 拖拽 / 缩放）
│   │       ├── modules/         #   知识模块面板（localStorage 持久化）+ toast
│   │       ├── source/          #   只读源码查看器（行高亮）
│   │       ├── api/             #   REST 客户端
│   │       ├── journal/ scope/  #   预留目录（UI 事件 / 作用域可见范围，仅 README）
│   │       └── styles/          #   全局样式（页面不滚动，组件内滚动）
│   └── shared/                  # 前后端共享类型定义
├── e2e/                         # Playwright 端到端测试
├── docs/                        # 设计方案 / UI 原型说明 / 调研报告
├── skills/                      # 引擎侧技能扩展目录
├── .env.example                 # LLM Provider 配置模板
└── turbo.json / pnpm-workspace.yaml
```

## 分析排除规则

首次导入时会在被导入仓库根目录生成可编辑的 `.tutorignore`（`.gitignore` 风格语法：注释、`*`、`?`、`**`、目录后缀与 `!` 重新包含规则），默认排除 `.git/`、`.tutor/`、各类 Agent 工作目录（`.claude/`、`.cursor/` 等）、`node_modules/`、构建产物与本地缓存；保存后自动触发重新分析。初始模板见 [.tutorignore.example](.tutorignore.example)，匹配实现见 `packages/engine/src/indexer/ignore.ts`。

## 快速开始

```sh
pnpm install        # postinstall 会自动准备 better-sqlite3 双 ABI 原生绑定
pnpm dev            # 同时启动 engine(:3001) 与 gui(:3000)
```

打开 `http://localhost:3000`，在导入页填入待学习仓库的路径（支持 `~/xxx`）即可。分析结果保存在该仓库的 `.tutor/`。

接入 LLM：复制 `.env.example` 为 `.env` 填写后 `set -a; source .env; set +a` 再启动。主力档（`TUTOR_TEACHING_PROVIDER` / `TUTOR_TEACHING_MODEL`）驱动教学对话（动作提议 + 措辞，每轮两次调用）；轻量档（`TUTOR_LIGHT_PROVIDER` / `TUTOR_LIGHT_MODEL`，可选）承担推荐入口、练习题面润色、宏观设计命名三个单轮轻任务，未配置时自动回落主力档。教学对话默认运行受限 agent loop（模型提议教学动作、状态机守门校验，无 LLM 配置或预算触顶时自动回落本地确定性路径），`TUTOR_AGENT_LOOP=off` 可退回纯工作流（意图识别走轻量档 LLM 分类）。

教学对话的三层记忆：会话内存（引擎内，重启即失）→ `.tutor/` journal 结构化事件（意图/动作来源、提示深度、熔断、token 用量，跨重启）→ 前端 thread 内存态 + localStorage 作用域。

常用命令：

```sh
pnpm test        # engine 单测（vitest）
pnpm build       # 全量构建
pnpm lint        # tsc --noEmit
pnpm test:e2e    # Playwright 端到端
```
