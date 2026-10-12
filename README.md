# Codebase Tutor

本地优先的代码库教学 Agent。导入一个真实仓库后，引擎会建立文件与 Git 热点索引、生成带源码锚点的课程树与宏观设计画布（架构视图 + 流程视图），并围绕「宏观设计 / 代码教学 / 练习评估」三作用域提供常驻 Agent 侧栏。所有分析结果、SQLite 数据库和不可变学习日志（journal）都保存在被导入仓库的 `.tutor/` 目录——你的代码不出本机。

## 项目简介

- **宏观设计**：左侧「项目目录」按真实目录分组展示（可折叠、带语义标签），右侧画布分两个视图切换——「架构视图」由文件驱动，节点是目录聚合模块、边是 import 依赖（箭头指向被依赖方，越粗引用越多）；「流程视图」由 LLM 生成执行环节，可重试、结果按版本缓存，起点分**核心流程入口**（引擎识别到的入口，走共用下拉、按 path 去重）与**自定义流程入口**（输入路径正则匹配已索引文件，就地列前 60 条命中）。两视图共用节点详情抽屉，抽屉展开时画布自动让位。
- **代码教学**：左侧「教学模块」的 chips 来自课程树的模块地图（模块跟着仓库走），按**主干 / 设施 / 外围**分成三个下拉（判据是模块可见文件的结构角色，零 LLM）+ LLM 推荐入口 + 仓库文件树；右侧为实时源码（多 tab、⌘P 快速搜索）。Agent 侧栏以「受限 agent loop」驱动教学对话：每轮 LLM 从固定动作菜单（推进 / 降脚手架 / 给答案 / 确认）提议动作，状态机守门校验教学法不变量（熔断前置、verify 阶段确认门禁），否决后回落确定性路径；上下文注入锚点附近真实源码摘录与完整近史，全程 journal 可审计。
- **练习评估**：固定模块「程序理解题」按全仓筛选出题目标，题型为输出预测 / 变更定位 / 影响分析，由受限执行与集合匹配自动判分，并按 SM-2 算法调度复习；另可自建出题主题走 LLM 出题族（一轮调用可拒绝，rubric 判分）。
- **界面自己可调**：右侧 Agent 侧栏可整栏收起（收成一条 44px 的边，上面留图标、竖排「对话」和一个「还在出字」的指示点——收起不打断在途回合，流式订阅住在 App 里）；三个工作区（宏观 / 教学 / 练习）里「左侧列表栏 ↔ 右栏」的分隔条、以及「主区 ↔ 对话栏」的分隔条都能拖——左侧列表栏三个工作区**共用一条宽度**，拖一次三页都跟（也可用 ←/→ 方向键，Shift 加速，双击回到缺省宽度）。这些是**用户偏好**，存 `localStorage`，跟产品数据无关；窗口窄到挤不下时按视口现算上限，但**不改你存的那份宽度**，放大窗口就回到原样。
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
│   │       ├── security/        #   密钥形态判据与隐去（secrets，入口出口共用一份）+ API key 装载与按仓授权（api-keys）+ 源码出境清单（dataflow）
│   │       ├── search/          #   检索第四臂的向量索引：文件级/函数级单元、增量哈希、余弦池化、RRF（当前只有评测台架在用）
│   │       ├── cost/            #   token 用量汇总与月度预算
│   │       ├── llm/             #   多 Provider LLM 抽象（运行时配置与密钥掩码 / 重试 / 故障转移 / 中止归因）+ embeddings 客户端
│   │       ├── store/           #   better-sqlite3 封装 + journal（JSONL 日志）
│   │       ├── turns/           #   在途回合注册表（「停止生成」的带外落点，按 turnId 掐断 signal）
│   │       ├── eval/            #   离线评测：零 token 判分器（scorers）+ LLM 裁判（judge）+ gold 用例（关键词集 / 整句中文集）
│   │       ├── trace/           #   请求 traceId 上下文 + 引擎自身 JSONL 日志
│   │       ├── scripts/         #   phase0 研究脚本（prepare-study / audit / run-trace / dataflow-report）+ phaseB 评测 + search:embed
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

多仓：引擎记一张**地址簿**（`~/.codebase-tutor/repositories.json`，你导入过的仓都在里面，最近使用的排在最后），启动时一条都不读产物、一个 fs 监听都不开；侧栏「仓库」下拉切到哪个仓，才把那个仓的 `.tutor` 产物挂进内存（同时只保留最近用过的 3 个，`TUTOR_MAX_MOUNTED` 可调，超出的按 LRU 驱逐——只关它的监听、从内存摘掉，磁盘产物一字不动，下次访问再挂回来）。三个学习视图是常驻挂载的（切 tab 不丢状态），所以花钱的取数（推荐入口、流程生成）都挂在**单向可见性闸门**上：没打开过的 tab 一次都不发，打开过之后按输入变化走，来回切 tab 不重发。挂载时顺手做一次**新鲜度判定**：把当前文件内容哈希与产物记录的 `versionStamp` 比、把当前 git HEAD 与分析时记的 HEAD 比。脏了就在页面顶部横幅**如实说明**（几天前跑的、多少个文件对不上、HEAD 从哪挪到哪），给你「去重新分析」（跳导入页、路径已填好，要你亲手点导入）或「知道，先用旧的」两条路——**引擎绝不自动重新分析，也不静默清掉你选过的仓**。目录被挪走 / `.tutor` 产物不全时同样只说原因，并给「移出地址簿」。

接入 LLM：**不必先配 `.env`**。GUI 侧栏输入框上方那颗模型胶囊就是唯一入口——点开通弹窗配服务商协议、模型 slug、接口地址、API Key 与思考档位，改完立即生效并保存到 `~/.codebase-tutor/llm-settings.json`（权限 0600，重启仍在；接口只回显掩码，明文密钥从不出库；胶囊上直接显示当前生效的模型与档位，没配齐时转「本地兜底」警示态）。`.env`（复制 `.env.example` 填写后 `set -a; source .env; set +a`）是降级策略：GUI 里留空的项沿用这里的 `TUTOR_LLM_PROVIDER` / `TUTOR_LLM_MODEL` / `TUTOR_OPENAI_URL` / `OPENAI_API_KEY` 等，`TUTOR_MODEL_PRESETS` 给模型输入框提供候选。两边都没配齐时引擎全本地可用（本地启发式摘要 + 规则教学）。只有一套模型配置，「轻任务」（推荐入口、题面润色、命名、L1 摘要）是**运行时角色**而非第二档，思考固定关闭。教学对话默认运行受限 agent loop（模型提议教学动作、状态机守门校验，无 LLM 配置或预算触顶时自动回落本地确定性路径），`TUTOR_AGENT_LOOP=off` 可退回纯工作流（意图识别走轻任务角色）。

教学对话的三层记忆：正文真源在引擎的 `chat_session` / `chat_message`（一问一答原子落库）→ `.tutor/` journal 结构化事件（意图/动作来源、提示深度、熔断、token 用量、回合文本，跨重启）→ 前端只攥 threadId，加上 localStorage 里的「上次停在哪个作用域/哪条线程」。

流式与中止：三处对话（宏观设计 / 代码教学 / 练习评估）统一走 SSE，事件为 `progress` / `delta` / `done` / `error` / `aborted`，回合节奏是「算完 → 落库 → 72 字分块回放」。每次发送带一个客户端生成的 `turnId`，「停止生成」按钮先打 `POST /api/turns/stop` 让引擎掐掉这一轮（点了停止 = 这一轮作废，不落库也不回放），再断自己的连接。连接因刷新页面或网络波动断开时**不算停止**——引擎照常把这一轮算完并落库，GUI 在 sessionStorage 记一笔「欠账」，回到会话时按 12s/30s/60s 退避回读正文，补上回复并明说发生了什么。细节见 [开发关键点问题与解决方案](docs/开发关键点问题与解决方案.md) 第十三节。

密钥不进模型、不进日志：`read_file` 取回源码时先按形态判据（`security/secrets.ts`）把疑似硬编码凭据换成占位文本，首行明写「另有 N 处疑似密钥已隐去（不要尝试补全）」；锚点摘录（教学/宏观设计/练习答疑共用的 `source/excerpt.ts`）与模型回复（下发与落库前）过同一份判据，改过字就在尾注当面说明，journal 只记数量与首个样例、**原文不进任何日志**。L1 摘要筛的是「发给模型的那份」与「回存的那份」，切片本身不动——摘要缓存键是 `hash(切片)`，动切片等于替每个用户重烧一遍全仓摘要。

数据流审计（企业化第 3 条）：`pnpm dataflow:report -- <被学习仓>` 回答「哪些代码片段流向了哪个 provider」。两条线各答一半，靠 `traceId + scene` 关联——仓内 `.tutor/journal.jsonl` 的 `code_egress` 记**装了哪几段**（路径、行区间、字符数、sha256 前 12 位、隐去处数；**正文一个字都不落**，`.tutor/` 是可随仓带走的东西），`~/.codebase-tutor/llm.log` 每行的 `outbound:{chars,hash}` 记**实际发出的那份载荷指纹**（在 `LoggingLlmProvider` 这个唯一收口算，工具 schema 与描述都算进载荷），外加 provider/model/token/调用方 `actor`。落账点一律贴着「真要发请求」那一侧：本地兜底与预算降级不发（`SummaryProvider.sendsCodeToEndpoint` 表态，漏写编译不过）、缓存命中虽装配一次但不发（装配用出参攒、只有发送处 booking）、外层字符预算裁掉的尾段不发（`recordEgress` 拿待发文本比一遍，不在其中的段不落账）——**虚报出境比漏报更难查**。工具循环 `read_file` 读到的内容不重复登记，报表按「同一 traceId 内的 file_read 也算出境」合并。**这条审计线谁都能读、但只有引擎能写自己的那部分**：`POST /api/repositories/:id/journal` 只受理界面侧那 10 类事件，其余（`file_read` / `code_egress` / `token_usage` / `turn_text` …）一律 400 + `reason: "engine_owned_event"`——否则被审计的一方可以自己填账，报表就白做了。两张写入权表在 shared 里并集即全集，并有编译期对账（加事件却漏归类 ⇒ 报错）。它**不防删改**（`.tutor/journal.jsonl` 是仓内普通文件），防篡改要外部投递或哈希链，那是另一件事。两条读数口径写在报表里：导入与监听刷新没有 traceId，那部分调用的 provider/token 不能按仓归属；只送派生内容（路径/标题/摘要）的场景按设计没有清单，报表末尾点名，「没有清单」与「漏了清单」分得开。

认证层（企业形态才需要，本机默认关）：`~/.codebase-tutor/api-keys.json`（`TUTOR_API_KEYS_FILE` 可改路径）写几张 key 就开闸——

```json
{ "keys": [{ "name": "CI", "key": "至少 16 字符的随机串", "repositories": ["*"] }] }
```

开闸后除 `/api/health` 与 CORS 预检以外，所有 `/api/*` 都要带 `x-api-key` 或 `Authorization: Bearer`，否则 401；`repositories` 是这张 key 能开哪些仓（仓 id 或 `*`），名单外的仓 403、在 `GET /api/repositories` 清单里不出现、懒挂载也轮不到它，跨仓工具（`read_file(repo=)` / `search_code(repo=)` / `cross_repo_link`）对它也不可见——对端仓名连工具 schema 都不进。改 key 不需要重启引擎（按文件 mtime 重读）。**没配文件 = 完全没有闸**，启动日志会明写「认证：未启用」，`/api/health` 的 `auth` 字段同理——这一句是刻意加的：闸门状态不该靠读代码才知道（同 §36.6 那条预算闸门的教训）。带 key 的调用，`actor`（= key 的 `name`）会进 `llm.log` 与 `engine.jsonl` 两条线，按人对账就有抓手。⚠️ 开闸后 GUI 自己还不能用的：它的请求不带凭据，而导入页的实时进度用的 `EventSource` 也带不了自定义头——闸门目前面向程序化访问（curl / CI / 另一个服务）。

常用命令：

```sh
pnpm test        # engine 单测（vitest）
pnpm build       # 全量构建
pnpm lint        # tsc --noEmit
pnpm test:e2e    # Playwright 端到端
```
