# Codebase Tutor

本地优先的代码库教学 Agent。导入一个真实仓库后，引擎会建立文件与 Git 热点索引、生成带源码锚点的课程树与宏观设计画布（架构视图 + 流程视图），并围绕「宏观设计 / 代码教学 / 练习评估」三作用域提供常驻 Agent 侧栏。所有分析结果、SQLite 数据库和不可变学习日志（journal）都保存在被导入仓库的 `.tutor/` 目录——你的代码不出本机。

## 项目简介

- **宏观设计**：左侧「项目目录」按真实目录分组展示（可折叠、带语义标签），右侧画布分两个视图切换——「架构视图」由文件驱动，节点是目录聚合模块、边是 import 依赖（箭头指向被依赖方，越粗引用越多）；「流程视图」由 LLM 生成执行环节，可重试、结果按版本缓存，起点分**核心流程入口**（引擎识别到的入口，走共用下拉、按 path 去重）与**自定义流程入口**（输入路径正则匹配已索引文件，就地列前 60 条命中）。两视图共用节点详情抽屉，抽屉展开时画布自动让位。
- **代码教学**：左侧「教学模块」的 chips 来自课程树的模块地图（模块跟着仓库走），按**主干 / 设施 / 外围**分成三个下拉（判据是模块可见文件的结构角色，零 LLM）+ LLM 推荐入口 + 仓库文件树；右侧为实时源码（多 tab、⌘P 快速搜索）。Agent 侧栏以「受限 agent loop」驱动教学对话：每轮 LLM 从固定动作菜单（推进 / 降脚手架 / 给答案 / 确认）提议动作，状态机守门校验教学法不变量（熔断前置、verify 阶段确认门禁），否决后回落确定性路径；上下文注入锚点附近真实源码摘录与完整近史，全程 journal 可审计。
- **练习评估**：固定模块「程序理解题」按全仓筛选出题目标，题型为输出预测 / 变更定位 / 影响分析，由受限执行与集合匹配自动判分，并按 SM-2 算法调度复习；另可自建出题主题走 LLM 出题族（一轮调用可拒绝，rubric 判分）。
- **成本监控**：本月 Token 用量仪表（金额、预算进度、逐日用量、按场景与按模型的分桶明细）+ 月度预算设置。金额按**三档单价**算——输入未命中 / 输入命中前缀缓存 / 输出，页面直接列出「计价明细」逐项 `tokens × 单价 = 金额`；单价由 `TUTOR_INPUT_USD_PER_MILLION` / `TUTOR_CACHE_HIT_USD_PER_MILLION` / `TUTOR_OUTPUT_USD_PER_MILLION` 配置，命中价没单独配时按输入价计（不打折，宁可高估也不说少），三档都没配时页面明说「金额恒为 $0.0000」而不让 $0.0000 被误读成没花钱。预算触顶后 LLM 调用自动降级为本地规则路径，页面同时显示降级回合数。

## 技术选型

| 层 | 选型 |
|---|---|
| **engine** | Fastify v5（REST + SSE 流式）、better-sqlite3（双 ABI 原生绑定）、typescript-language-server（LSP 语义增强）、tsx 开发运行时 |
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
│   │       ├── server.ts        #   全部 REST 路由 + SSE 流式接口 + 启动计时
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
│   │       ├── tutor-settings/  #   教学设置（风格/教学法/层次）与校验、由设置推导 TeachingPolicy
│   │       ├── exercises/       #   练习生成、判分、LLM 题面润色、SM-2 复习、ZPD 选题
│   │       ├── learner/         #   学习者画像 / 掌握度推导（mastery.ts）/ 渐隐提示
│   │       ├── scopechat/       #   宏观设计与练习两作用域的对话（上下文 + 受限读码工具循环）
│   │       ├── source/          #   只读源码工具：read_file / search_code / 摘录 / tool-loop
│   │       ├── cost/            #   token 用量汇总与月度预算
│   │       ├── llm/             #   多 Provider LLM 抽象（运行时配置与密钥掩码 / 重试 / 故障转移 / 中止归因）
│   │       ├── store/           #   better-sqlite3 封装 + journal（JSONL 日志）
│   │       ├── turns/           #   在途回合注册表（「停止生成」的带外落点，按 turnId 掐断 signal）
│   │       ├── eval/            #   离线评测：零 token 判分器（scorers）+ LLM 裁判（judge）
│   │       ├── trace/           #   请求 traceId 上下文 + 引擎自身 JSONL 日志
│   │       ├── scripts/         #   phase0 研究脚本（prepare-study / audit / run-trace）
│   │       └── lib.ts           #   hash / id / 路径工具
│   ├── gui/                     # 前端（Vite dev server，:3000，/api 代理到 engine）
│   │   ├── public/              #   design-prototype.html（界面基线）+ 截图
│   │   └── src/
│   │       ├── App.tsx          #   shell + 侧栏导航 + 单主区 Workbench
│   │       ├── views/           #   宏观设计 / 代码教学 / 练习评估 / 导入 / 成本监控
│   │       ├── agent/           #   持久 Agent 侧栏 + useScopedChat 状态源
│   │       ├── map/             #   DepMap 架构视图（分层自动布局 + 依赖箭头）/ FlowMap 流程视图（LLM 环节 + 重试）
│   │       ├── modules/         #   教学模块面板（课程树派生 + 覆盖层持久化）+ toast
│   │       ├── source/          #   只读源码查看器（行高亮）
│   │       ├── api/             #   REST 客户端
│   │       ├── journal/         #   UI 事件埋点：POST 进引擎同一条 .tutor journal（localStorage 重试队列）
│   │       ├── scope/           #   仅设计说明（作用域可见范围），实现未抽离
│   │       └── styles/          #   全局样式（页面不滚动，组件内滚动）
│   └── shared/                  # 前后端共享类型定义
├── e2e/                         # Playwright 端到端测试
├── docs/                        # 设计方案 / UI 原型说明 / 调研报告
├── skills/                      # 引擎侧技能扩展目录
├── .env.example                 # LLM Provider 配置模板
└── turbo.json / pnpm-workspace.yaml
```

## 命名口径

文件名是唯一的注释入口，所以口径写死在这里（2026-09-30 按此收敛了一轮）：

- **模块主入口与目录同名**：`harness/harness.ts`、`importer/importer.ts`、`cost/cost.ts`、`scopechat/scopechat.ts`；其余文件按内容命名（`exercises/sm2.ts`、`coursetree/entry-suggest.ts`）。不再新增 `service.ts` 这类零信息名。
- **一个词只指一件事**：`provider` 只指 LLM 提供方（`llm/provider.ts`，摘要侧改叫 `summarizer/summary-provider.ts`）；`verify` 只指分析结果体检（`quality/checker.ts` 的 `verifyAnalysis`），LLM 出题的确定性否决归到 `exercises/guard-proposal.ts`；掌握度推导统一在 `learner/mastery.ts`，练习侧只留 ZPD 选题 `exercises/zpd.ts`；教学设置与 `TeachingPolicy` 推导从 `policy/` 移到 `tutor-settings/`。
- **同一条教学会话有三个名字，但只有一个 id**：库里 `chat_session` 的行 id = GUI 的 `threadId` = 引擎的 `sessionId`。GUI 侧一律讲"线程"（`useScopedChat` / `chatThreads` / `ThreadItem`），`TutorSession` 专指引擎那份在途教学状态（stage / fallbackCount / settings）。DB 表名与 `sessionId` 字段刻意不改：它们已写进存量库和 journal，改名等于要求所有已导入仓库做迁移。

## 分析排除规则

首次导入时会在被导入仓库根目录生成可编辑的 `.tutorignore`（`.gitignore` 风格语法：注释、`*`、`?`、`**`、目录后缀与 `!` 重新包含规则），默认排除 `.git/`、`.tutor/`、各类 Agent 工作目录（`.claude/`、`.cursor/` 等）、`node_modules/`、构建产物与本地缓存；保存后自动触发重新分析。初始模板见 [.tutorignore.example](.tutorignore.example)，匹配实现见 `packages/engine/src/indexer/ignore.ts`。

## 快速开始

```sh
pnpm install        # postinstall 会自动准备 better-sqlite3 双 ABI 原生绑定
pnpm dev            # 同时启动 engine(:3001) 与 gui(:3000)
```

打开 `http://localhost:3000`，在导入页填入待学习仓库的路径（支持 `~/xxx`）即可。分析结果保存在该仓库的 `.tutor/`。

接入 LLM：**不必先配 `.env`**。GUI 侧栏输入框上方那颗模型胶囊就是唯一入口——点开通弹窗配服务商协议、模型 slug、接口地址、API Key 与思考档位，改完立即生效并保存到 `~/.codebase-tutor/llm-settings.json`（权限 0600，重启仍在；接口只回显掩码，明文密钥从不出库；胶囊上直接显示当前生效的模型与档位，没配齐时转「本地兜底」警示态）。`.env`（复制 `.env.example` 填写后 `set -a; source .env; set +a`）是降级策略：GUI 里留空的项沿用这里的 `TUTOR_LLM_PROVIDER` / `TUTOR_LLM_MODEL` / `TUTOR_OPENAI_URL` / `OPENAI_API_KEY` 等，`TUTOR_MODEL_PRESETS` 给模型输入框提供候选。两边都没配齐时引擎全本地可用（本地启发式摘要 + 规则教学）。只有一套模型配置，「轻任务」（推荐入口、题面润色、命名、L1 摘要）是**运行时角色**而非第二档，思考固定关闭。教学对话默认运行受限 agent loop（模型提议教学动作、状态机守门校验，无 LLM 配置或预算触顶时自动回落本地确定性路径），`TUTOR_AGENT_LOOP=off` 可退回纯工作流（意图识别走轻任务角色）。

教学对话的三层记忆：正文真源在引擎的 `chat_session` / `chat_message`（一问一答原子落库）→ `.tutor/` journal 结构化事件（意图/动作来源、提示深度、熔断、token 用量、回合文本，跨重启）→ 前端只攥 threadId，加上 localStorage 里的「上次停在哪个作用域/哪条线程」。

流式与中止：三处对话（宏观设计 / 代码教学 / 练习评估）统一走 SSE，事件为 `progress` / `delta` / `done` / `error` / `aborted`，回合节奏是「算完 → 落库 → 72 字分块回放」。每次发送带一个客户端生成的 `turnId`，「停止生成」按钮先打 `POST /api/turns/stop` 让引擎掐掉这一轮（点了停止 = 这一轮作废，不落库也不回放），再断自己的连接。连接因刷新页面或网络波动断开时**不算停止**——引擎照常把这一轮算完并落库，GUI 在 sessionStorage 记一笔「欠账」，回到会话时按 12s/30s/60s 退避回读正文，补上回复并明说发生了什么。细节见 [开发关键点问题与解决方案](docs/开发关键点问题与解决方案.md) 第十三节。

常用命令：

```sh
pnpm test        # engine 单测（vitest）
pnpm build       # 全量构建
pnpm lint        # tsc --noEmit
pnpm test:e2e    # Playwright 端到端
```
