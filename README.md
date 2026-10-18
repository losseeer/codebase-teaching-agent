# Codebase Tutor

本地优先的代码库教学 Agent。导入一个真实仓库后，引擎会建立文件与 Git 热点索引、生成带源码锚点的课程树与宏观设计画布（架构视图 + 流程视图），并围绕「宏观设计 / 代码教学 / 练习评估」三作用域提供常驻 Agent 侧栏。所有分析结果、SQLite 数据库和不可变学习日志（journal）都保存在被导入仓库的 `.tutor/` 目录——你的代码不出本机。

## 项目简介

- **宏观设计**：左侧「项目目录」按真实目录分组展示（可折叠、带语义标签），右侧画布分两个视图切换——「架构视图」是**分层全景**（`GET /api/repositories/:id/architecture`）：一条系统边界内 3~5 个职责层、层名与归层由一次 light 档调用判，跨层箭头与「边界之外」的存储/缓存/队列/外部服务只由静态 import 与确定性词典算（模型插不进一条边，输出里出现这类字段会被丢弃并留读数）；画布只读：改图只剩对话里的 agent 走 `set_architecture`（挪层、改层名、改档、撤销都写进服务端覆盖层），换一张画法走 `redraw_diagram`——agent 只能 `propose`，「开始重绘」与「替换这张」两下由用户在画布横幅上按，**读侧一发不发**：打开画布、挪模块、重取都不产生调用，只有点「重新生成分层」那一下花一发（≈¥0.02）并先弹确认；没配模型、没判过、判断没采信或调用失败，就整块显示「分层不可用」并说清是哪一种——不再拿按结构角色分的三档冒充职责分层。层里的方块是压过的：没人引用、入口也走不到的模块直接不画，同父同角色的几个小目录合成一格（点开看成员），一层超过 6 格先折起。「流程视图」由 LLM 生成执行环节，可重试、结果按版本缓存，起点分**核心流程入口**（引擎识别到的入口：Java/Spring 注解、Python 框架约定、Go/Rust/C/C#/主函数、Node 的 Fastify / Express / Koa / Nest 登记与 listen 都算服务入口，走共用下拉、按 path 去重）与**自定义流程入口**（输入路径正则匹配已索引文件，就地列前 60 条命中）。两视图共用节点详情抽屉，抽屉展开时画布自动让位。
- **代码教学**（问答形状；2026-10-14 撤掉教学状态机，域内不再推进阶段、不再有提示阶梯）：左侧「教学模块」的 chips 来自课程树的模块地图（模块跟着仓库走），按**主干 / 设施 / 外围**分成三组（判据是模块可见文件的结构角色，零 LLM；档位只读，要改在对话里让 agent 走 `set_tier`）+ LLM 推荐入口 + 仓库文件树（推荐入口不可能是文档：文档不进候选池，LLM 不可用时的回落清单同样不含它——代码问答的起点必须是代码）；右侧为实时源码（多 tab、⌘P 快速搜索）。节点详情抽屉只给摘要与「核心相关文件」，规模与 Git 热点这类数字不上画面（问 agent 就有）。Agent 侧栏在这个作用域里做**一轮问答**：装配锚点附近真实源码摘录与完整近史 → 模型可按需 `read_file` / `search_code` 补看（2 轮 / 3 次上限）→ 直接回答，一回合一趟措辞调用，全程 journal 可审计。
- **练习评估**：题型分两批。**不跑代码的理解题**（变更定位 / 影响分析）由静态分析出题、集合精确匹配判分。**代码题**（改代码 / 写代码）由模型出题——它得一次交齐「题面 + 下发件 + 参考解 + 测试与替身」，引擎在**本机沙箱**里跑两趟自证（参考解必须全过、下发件必须至少挂一条）才允许落库；测试结论只认模型自己印的那行 `TESTS <通过> <失败>`，不认退出码（否则「下发件语法坏了」会被当成「缺陷版本来就该挂」）。判分只由那组冻结测试决定（`automatic=true`，模型不参与），按 SM-2 调度复习；「这版差在哪」的讲评**默认不发**，判完之后界面点一次才走一趟模型。沙箱是 macOS Seatbelt 强制的（断网、禁 fork、超时杀整个进程组、输出封顶；拒读家目录**加上这一次被学习仓的根**——仓可以不在家目录里，而 `.tutor/tutor.db` 装着标准答案，所以三个产品入口都必须把仓的根交下去），开机跑逐项 canary 探测（含「仓在家目录之外也读不到」与「经符号链接绕行也读不到」，每条都带沙箱外对照组）——**探测不过就把整个代码题域禁用**，不降级成「弱隔离照跑」，状态在 `/api/health` 的 `sandbox` 格里（含逐项读数与对照组）。另可自建出题主题走 LLM 出题族（一轮调用可拒绝，rubric 判分，`automatic=false`）。旧档「预测输出」已于 2026-10-14 删除：它的判据在 1222 个实现单元里只命中 2 个，同一段代码沙箱能做且做得更好。
- **界面自己可调**：右侧 Agent 侧栏可整栏收起（收起时这一栏整条不渲染，靠顶栏那颗图标再展开——收起不打断在途回合，流式订阅住在 App 里）；三个工作区（宏观 / 教学 / 练习）里「左侧列表栏 ↔ 右栏」的分隔条、以及「主区 ↔ 对话栏」的分隔条都能拖——左侧列表栏三个工作区**共用一条宽度**，拖一次三页都跟（也可用 ←/→ 方向键，Shift 加速，双击回到缺省宽度）。这些是**用户偏好**，存 `localStorage`，跟产品数据无关；窗口窄到挤不下时按视口现算上限，但**不改你存的那份宽度**，放大窗口就回到原样。
- **成本监控**：本月 Token 用量仪表（金额、预算进度、逐日用量、按场景与按模型的分桶明细）+ 月度预算设置。金额按**三档单价**算——输入未命中 / 输入命中前缀缓存 / 输出，页面直接列出「计价明细」逐项 `tokens × 单价 = 金额`。单价有两个填法：对话栏那排「模型与推理」弹窗里的**输入 / 命中 / 输出**三格（存 `~/.codebase-tutor/llm-settings.json`，改完**立即生效**，成本读数与预算闸门下一发就认），或 `.env` 的 `TUTOR_INPUT_USD_PER_MILLION` / `TUTOR_CACHE_HIT_USD_PER_MILLION` / `TUTOR_OUTPUT_USD_PER_MILLION`（弹窗里留空的那格回落到它，改 .env 仍需重启）。**币种口径：算术里没有币种**——`tokens × 单价 ÷ 一百万`，单价填哪种币就算出哪种币的钱，界面与引擎**不做任何汇率换算**。本项目按**人民币 / 百万 token** 填与显示（DeepSeek 峰时约 ¥2 / ¥0.2 / ¥8），金额读数一律带 `¥`。变量名里的 `USD`（`TUTOR_*_USD_PER_MILLION`）与字段名里的 `Usd`（`inputPerMillionUsd`、`monthlyBudgetUsd`）是历史遗留：改名会同时牵动已落盘的 `llm-settings.json`、库里的 `repository_state.settings_json` 与接口契约，所以留着，别按名字把数值当美元读。命中价没单独配时按输入价计（不打折，宁可高估也不说少），三档都没配时页面明说「金额恒为 ¥0.0000」而不让 ¥0.0000 被误读成没花钱。预算触顶后 LLM 调用自动降级为本地规则路径，页面同时显示降级回合数。

## 技术选型

| 层 | 选型 |
|---|---|
| **engine** | Fastify v5（REST + SSE 流式）、better-sqlite3（双 ABI 原生绑定）、typescript-language-server（LSP 语义增强）、tsx 开发运行时 |
| **gui** | Vite 6 + React 19 + react-router-dom v7 + lucide-react |
| **shared** | 前后端共享 TypeScript 类型（workspace 内直接引用源码） |
| **LLM** | 多 Provider 抽象（OpenAI / OpenAI 兼容端点如 DeepSeek / Anthropic / Ollama）；**只有一套模型配置**，「轻任务」是运行时角色（推荐入口、命名、L1 摘要、分层）而非第二档，思考固定关闭 |
| **工具链** | pnpm 10 workspace + turbo；vitest + Playwright（`e2e/`）；TypeScript 5.8；concurrently 双进程开发；GitHub Actions 跑 `install → lint → test → build`（`.github/workflows/ci.yml`，不发 npm 故无发布流) |

## 仓库结构

```
.
├── packages/
│   ├── engine/                  # 分析与教学引擎（Fastify API，:3001）
│   │   ├── src/
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
│   │       ├── harness/         #   问答回合编排（上下文组装 + 工具循环 + LLM 一次回答）
│   │       ├── tutor-settings/  #   教学设置（风格/教学法/层次）与校验、由设置推导 TeachingPolicy
│   │       ├── exercises/       #   练习生成（含模型出题 + 沙箱两跑自证）、判分、题面润色、按需讲评、SM-2 复习、ZPD 选题
│   │       ├── sandbox/         #   判分用的一次性沙箱：Seatbelt profile、runner（超时杀进程组 + 内存/输出上限）、逐项隔离探测与 fail-closed 闸门
│   │       ├── learner/         #   学习者画像 / 掌握度推导（mastery.ts）/ 渐隐提示
│   │       ├── scopechat/       #   宏观设计与练习两作用域的对话（上下文 + 受限读码工具循环）
│   │       ├── source/          #   只读源码工具：read_file / search_code / 摘录 / tool-loop
│   │       ├── security/        #   密钥形态判据与隐去（secrets，入口出口共用一份）+ 可信来源判据（origins）+ 源码出境清单（dataflow）
│   │       ├── search/          #   检索第四臂的向量索引：文件级/函数级单元、增量哈希、余弦池化、RRF（当前只有评测台架在用）
│   │       ├── cost/            #   token 用量汇总与月度预算
│   │       ├── llm/             #   多 Provider LLM 抽象（运行时配置与密钥掩码 / 重试 / 故障转移 / 中止归因）+ embeddings 客户端
│   │       ├── store/           #   better-sqlite3 封装 + journal（JSONL 日志）
│   │       ├── skills/          #   技能加载：清单常驻上下文、正文由 read_skill 按需取（默认关）
│   │       ├── mcp/             #   MCP 客户端：外部 server 的工具并进本轮工具清单（默认关；正文不过夜、审计留指针）
│   │       ├── turns/           #   在途回合注册表（「停止生成」的带外落点，按 turnId 掐断 signal）
│   │       ├── eval/            #   离线评测：零 token 判分器（scorers）+ LLM 裁判（judge）+ gold 用例（关键词集 / 整句中文集）
│   │       ├── trace/           #   请求 traceId 上下文 + 引擎自身 JSONL 日志
│   │       ├── scripts/         #   phase0 研究脚本（prepare-study / audit / run-trace / dataflow-report）+ phaseB 评测 + search:embed
│   │       └── lib.ts           #   hash / id / 路径工具
│   │   └── skills/              #   出厂预置技能的源目录：开机复制到 TUTOR_SKILLS_DIR 第一处（同名不覆盖、坏形状不搬）
│   ├── gui/                     # 前端（Vite dev server，:3000，/api 代理到 engine）
│   │   ├── public/              #   design-prototype.html（界面基线）+ 截图
│   │   └── src/
│   │       ├── App.tsx          #   shell + 侧栏导航 + 单主区 Workbench
│   │       ├── views/           #   宏观设计 / 代码教学 / 练习评估 / 导入 / 成本监控
│   │       ├── agent/           #   持久 Agent 侧栏 + useScopedChat 状态源
│   │       ├── map/             #   ArchOverview 架构视图（分层全景、只读、方块压缩与折叠）/ FlowMap 流程视图（LLM 环节 + 重试）
│   │       ├── modules/         #   教学模块面板（课程树派生 + 覆盖层持久化）+ toast
│   │       ├── source/          #   只读源码查看器（行高亮）
│   │       ├── api/             #   REST 客户端
│   │       ├── journal/         #   UI 事件埋点：POST 进引擎同一条 .tutor journal（localStorage 重试队列）
│   │       ├── scope/           #   仅设计说明（作用域可见范围），实现未抽离
│   │       └── styles/          #   全局样式（页面不滚动，组件内滚动）
│   └── shared/                  # 前后端共享类型定义
├── e2e/                         # Playwright 端到端测试
├── docs/                        # 设计方案 / UI 原型说明 / 调研报告（本地维护，不入 git）
├── .github/workflows/ci.yml     # 唯一的工作流：install → lint → test → build
├── .env.example                 # LLM Provider 配置模板
└── turbo.json / pnpm-workspace.yaml
```

## 命名口径

文件名是唯一的注释入口，所以口径写死在这里（2026-09-30 按此收敛了一轮）：

- **模块主入口与目录同名**：`harness/harness.ts`、`importer/importer.ts`、`cost/cost.ts`、`scopechat/scopechat.ts`；其余文件按内容命名（`exercises/sm2.ts`、`coursetree/entry-suggest.ts`）。不再新增 `service.ts` 这类零信息名。
- **一个词只指一件事**：`provider` 只指 LLM 提供方（`llm/provider.ts`，摘要侧改叫 `summarizer/summary-provider.ts`）；`verify` 只指分析结果体检（`quality/checker.ts` 的 `verifyAnalysis`），LLM 出题的确定性否决归到 `exercises/guard-proposal.ts`；掌握度推导统一在 `learner/mastery.ts`，练习侧只留 ZPD 选题 `exercises/zpd.ts`；教学设置与 `TeachingPolicy` 推导从 `policy/` 移到 `tutor-settings/`。
- **同一条教学会话有三个名字，但只有一个 id**：库里 `chat_session` 的行 id = GUI 的 `threadId` = 引擎的 `sessionId`。GUI 侧一律讲"线程"（`useScopedChat` / `chatThreads` / `ThreadItem`），`TutorSession` 专指引擎那份在途会话状态（settings + 正文；2026-10-14 撤掉状态机后不再有 stage / fallbackCount）。DB 表名与 `sessionId` 字段刻意不改：它们已写进存量库和 journal，改名等于要求所有已导入仓库做迁移。

## 分析排除规则

首次导入时会在被导入仓库根目录生成可编辑的 `.tutorignore`（`.gitignore` 风格语法：注释、`*`、`?`、`**`、目录后缀与 `!` 重新包含规则），默认排除 `.git/`、`.tutor/`、各类 Agent 工作目录（`.claude/`、`.cursor/` 等）、`node_modules/`、构建产物与本地缓存；保存后自动触发重新分析。初始模板见 [.tutorignore.example](.tutorignore.example)，匹配实现见 `packages/engine/src/indexer/ignore.ts`。

`.tutorignore` 之外还有两道：**扩展名白名单**（`.png`、`.mp4`、锁文件这类不进收录集，白烧字节也毁热点计数）与**密钥载体名**（`credentials.json`、`id_rsa`、`.env` 这类读层判「不开放读取」的文件也不进收录集——界面上点不到原文，索引里却收着它，两边迟早漂移）。三份判据合在一处：`isIngestedPath`（`packages/engine/src/indexer/indexer.ts`）。

文件监听**只被「可能改变收录集」的改动**叫醒：往仓里放图片、改 `.env`、监听建流时 macOS 倒还的目录历史、引擎自己播种的那份 `.tutorignore`，都不排重分析；就算叫醒了，重扫出来收录集与每文件哈希一模一样也判为 noop（不回写、不换内存产物、不广播，只在引擎日志留一行 `reindex{noop:true}`）。成因与实测读数见 docs/开发关键点问题与解决方案.md §58。

## 快速开始

```sh
pnpm install        # postinstall 会自动准备 better-sqlite3 双 ABI 原生绑定
pnpm dev            # 同时启动 engine(:3001) 与 gui(:3000)
```

打开 `http://localhost:3000`，在导入页填入待学习仓库的路径（支持 `~/xxx`）即可。分析结果保存在该仓库的 `.tutor/`。

多仓：引擎记一张**地址簿**（`~/.codebase-tutor/repositories.json`，你导入过的仓都在里面，最近使用的排在最后），启动时一条都不读产物、一个 fs 监听都不开；侧栏「仓库」下拉切到哪个仓，才把那个仓的 `.tutor` 产物挂进内存（同时只保留最近用过的 3 个，`TUTOR_MAX_MOUNTED` 可调，超出的按 LRU 驱逐——只关它的监听、从内存摘掉，磁盘产物一字不动，下次访问再挂回来）。三个学习视图是常驻挂载的（切 tab 不丢状态），所以花钱的取数（推荐入口、流程生成）都挂在**单向可见性闸门**上：没打开过的 tab 一次都不发，打开过之后按输入变化走，来回切 tab 不重发。挂载时顺手做一次**新鲜度判定**：把当前文件内容哈希与产物记录的 `versionStamp` 比、把当前 git HEAD 与分析时记的 HEAD 比。脏了就在页面顶部横幅**如实说明**（几天前跑的、多少个文件对不上、HEAD 从哪挪到哪），给你「去重新分析」（跳导入页、路径已填好，要你亲手点导入）或「知道，先用旧的」两条路——**引擎绝不自动重新分析，也不静默清掉你选过的仓**。目录被挪走 / `.tutor` 产物不全时同样只说原因，并给「移出地址簿」。

外部能力面（**产品 agent 消费外部东西**，默认关闭）**照业界现成的规格做，不自研格式**：技能按公开的 Agent Skills 规格读——一个目录一份 `SKILL.md`，frontmatter 必填 `name`（≤64 字、小写字母/数字/单个连字符、等于目录名）与 `description`（≤1024 字，原样进清单不裁短），可选 `license` / `allowed-tools` / `metadata` 解析但不消费（这个产品的权限落在代码那侧）；三级加载就是规格里的 progressive disclosure——清单常驻上下文，正文与目录内**附属文件**由 `read_skill` 按需取（`file` 参数只接该技能目录内的相对路径，绝对路径、`..`、二进制一律不接）；默认认 `~/.codebase-tutor/skills` 与 `~/.claude/skills` 两处（后者让社区已发布的那批技能直接可用）；**出厂预置技能住在 `packages/engine/skills/`**，开机把那里**合规格**的整目录复制到上面第一处（`TUTOR_SKILLS_DIR` 显式设置时，目标就是你列的第一处），**同名一律不覆盖**（你改过的那份就是你的，要更新请删了重启）、坏形状不搬并把原因写进开机读数——加载器因此只认一条路径，运行时不存在「出厂档」这种隐藏优先级。10-18 删掉的那六份运维手册删的是**内容**（它们是 README 与开发日志的副本，留着迟早漂移），不是这条通道。，`TUTOR_SKILLS_DIR` 可用 `:` 或 `,` 列多处，**刻意不扫被学习仓里的 `skills/`**——仓自带的指令文件直接进 agent 上下文是提示注入面。MCP 那侧用官方 SDK 做客户端，配置文件形状跟各家客户端一致：顶层 `mcpServers`，一段一个 server（`command` / `args` / `env`，关掉写 `disabled`），白名单 `allowedTools`（取值认 `mcp__<server>__<tool>` 这种完整 id，也认裸工具名），工具名同样带 `mcp__<server>__` 前缀，单次调用有墙钟上限（`TUTOR_MCP_TIMEOUT_MS`，缺省 20s）。**远程 server（`url` / `type`）现在不接**，被跳过时会把原因写进读数——前置是 #175（外部调用的出境记账与 fail-closed）。

默认关不是开关而是「不加」：没配 = 工具清单与上下文逐字不变，一分钱不多付（每条外部工具的 schema 都进每轮请求，还会改前缀缓存的形状）。第三方报什么工具都不自动算数——`allowedTools` 没写就等于把别人的全部能力交到模型手上，因为那些程序做了什么我们看不见。外部结果进模型前过一次密钥筛，参数正文从不落日志（`mcp_call` 那行只有字符数与 12 位指纹，且**不能**当源码出网的证据）。装了什么的读数：`GET /api/external`（零 token；读它会顺带把没连上的 server 拉起一次——「连不上」要实测）。

两个**控制口**（都是 API/命令行能力，界面上没有按钮，同「能力优先做成工具」那条口径）：`POST /api/repositories/:id/watch` 按仓挂起增量监听——存在的理由是这台机器上「改代码的人」与「正在被学习的仓」常常是同一批文件（引擎在学它自己），一轮编辑就会叫醒一次重分析并烧 light 档调用；挂起缺省 30 分钟（`ttlMs` 可调，夹在 1 分钟~6 小时），到点自动恢复并**重算一次新鲜度**，脏了仍由横幅如实说、要不要重烧由你点，地址簿里 `watchPaused` 与「监听坏了」是两格不同的读数。`POST /api/sandbox/reprobe` 当场重跑一遍沙箱隔离探测并交回新状态——探测没过时代码题域整域禁用（fail-closed）这条不变，这里只是把「必须重启引擎才能恢复」换成一句话。

接入 LLM：**不必先配 `.env`**。GUI 侧栏输入框上方那颗模型胶囊就是唯一入口——点开通弹窗配服务商协议、模型 slug、接口地址、API Key 与思考档位，改完立即生效并保存到 `~/.codebase-tutor/llm-settings.json`（权限 0600，重启仍在；接口只回显掩码，明文密钥从不出库；胶囊上直接显示当前生效的模型与档位，没配齐时转「本地兜底」警示态）。`.env`（复制 `.env.example` 填写后 `set -a; source .env; set +a`）是降级策略：GUI 里留空的项沿用这里的 `TUTOR_LLM_PROVIDER` / `TUTOR_LLM_MODEL` / `TUTOR_OPENAI_URL` / `OPENAI_API_KEY` 等，`TUTOR_MODEL_PRESETS` 给模型输入框提供候选。两边都没配齐时引擎仍能本地用（本地启发式摘要与流程降级），但**三条对话作用域（宏观设计 / 代码教学 / 练习答疑）都是真调模型**：没配齐或本月预算触顶就 422 明说，不再回一段看着像答案的本地文案。只有一套模型配置，「轻任务」（推荐入口、题面润色、命名、L1 摘要）是**运行时角色**而非第二档，思考固定关闭。

教学对话的三层记忆：正文真源在引擎的 `chat_session` / `chat_message`（一问一答原子落库）→ `.tutor/` journal 结构化事件（token 用量、回合文本、工具循环轮次、文件读取与出境清单，跨重启）→ 前端只攥 threadId，加上 localStorage 里的「上次停在哪个作用域/哪条线程」。

流式与中止：三处对话（宏观设计 / 代码教学 / 练习评估）统一走 SSE，事件为 `progress` / `delta` / `done` / `error` / `aborted`，回合节奏是「算完 → 落库 → 72 字分块回放」。每次发送带一个客户端生成的 `turnId`，「停止生成」按钮先打 `POST /api/turns/stop` 让引擎掐掉这一轮（点了停止 = 这一轮作废，不落库也不回放），再断自己的连接。连接因刷新页面或网络波动断开时**不算停止**——引擎照常把这一轮算完并落库，GUI 在 sessionStorage 记一笔「欠账」，回到会话时按 12s/30s/60s 退避回读正文，补上回复并明说发生了什么。细节见 [开发关键点问题与解决方案](docs/开发关键点问题与解决方案.md) 第十三节。

密钥不进模型、不进日志：`read_file` 取回源码时先按形态判据（`security/secrets.ts`）把疑似硬编码凭据换成占位文本，首行明写「另有 N 处疑似密钥已隐去（不要尝试补全）」；锚点摘录（教学/宏观设计/练习答疑共用的 `source/excerpt.ts`）与模型回复（下发与落库前）过同一份判据，改过字就在尾注当面说明，journal 只记数量与首个样例、**原文不进任何日志**。L1 摘要筛的是「发给模型的那份」与「回存的那份」，切片本身不动——摘要缓存键是 `hash(切片)`，动切片等于替每个用户重烧一遍全仓摘要。

数据流审计（企业化第 3 条）：`pnpm dataflow:report -- <被学习仓>` 回答「哪些代码片段流向了哪个 provider」。两条线各答一半，靠 `traceId + scene` 关联——仓内 `.tutor/journal.jsonl` 的 `code_egress` 记**装了哪几段**（路径、行区间、字符数、sha256 前 12 位、隐去处数；**正文一个字都不落**，`.tutor/` 是可随仓带走的东西），`~/.codebase-tutor/llm.log` 每行的 `outbound:{chars,hash}` 记**实际发出的那份载荷指纹**（在 `LoggingLlmProvider` 这个唯一收口算，工具 schema 与描述都算进载荷），外加 provider/model/token，以及 `attempts`/`attemptMs`（第几次尝试给的结论、每次各跑多久——日志包在重试层外面，不带这两格就读不出超时到底发生过没有，§62）。`pnpm llm:profile` 把这些按场景切成一张耗时/失败/token/费用对照表。落账点一律贴着「真要发请求」那一侧：本地兜底与预算降级不发（`SummaryProvider.sendsCodeToEndpoint` 表态，漏写编译不过）、缓存命中虽装配一次但不发（装配用出参攒、只有发送处 booking）、外层字符预算裁掉的尾段不发（`recordEgress` 拿待发文本比一遍，不在其中的段不落账）——**虚报出境比漏报更难查**。工具循环 `read_file` 读到的内容不重复登记，报表按「同一 traceId 内的 file_read 也算出境」合并。**档里有一格装的不是仓内源码**：`sandbox-output` 是代码题按需讲评发出去的那一份——学习者写的代码 + 测试输出摘要，`path` 是**沙箱内相对路径**，所以这一条在报表里对不上任何仓内文件是形状如此，不是漏登。**这条审计线谁都能读、但只有引擎能写自己的那部分**：`POST /api/repositories/:id/journal` 只受理界面侧那 10 类事件，其余（`file_read` / `code_egress` / `token_usage` / `turn_text` …）一律 400 + `reason: "engine_owned_event"`——否则被审计的一方可以自己填账，报表就白做了。两张写入权表在 shared 里并集即全集，并有编译期对账（加事件却漏归类 ⇒ 报错）。它**不防删改**（`.tutor/journal.jsonl` 是仓内普通文件），防篡改要外部投递或哈希链，那是另一件事。两条读数口径写在报表里：导入与监听刷新没有 traceId，那部分调用的 provider/token 不能按仓归属；只送派生内容（路径/标题/摘要）的场景按设计没有清单，报表末尾点名，「没有清单」与「漏了清单」分得开。

来源闸（本机**唯一**的 Web 闸）：引擎只听 `127.0.0.1`，但浏览器里任意网页照样能把请求打到这个地址——发请求不需要跨域权限，只有读响应才需要，而旧写法 `cors: { origin: true }` 恰好把响应递给了任何来源。所以有一道判据：只信「没有 `Origin` 头的调用方」（本机 curl、进程管理器、GUI 的同源请求）与「回环来源」（`http(s)://localhost|127.0.0.1|[::1]` 任意端口，vite `:3000` → 引擎 `:3001` 属这类），其余**当场 403（`origin_not_trusted`）且 handler 一行都不执行**——只不给 CORS 头不够，写类路由那样照样会把状态改掉。跨来源部署把完整 origin 写进 `TUTOR_ALLOWED_ORIGINS`（逗号/空格分隔，精确到端口，不是前缀匹配）。这一道**不豁免** `/api/health`：健康读数里有服务商、模型名与沙箱闸门状态，别让任意网页白拿。判据一处：`packages/engine/src/security/origins.ts`。

**认证闸（API key、按仓授权、调用方身份）已于 2026-10-15 整体撤除**，理由与留下的边界见开发日志 §64。现在的形状说清楚：

- 来源闸只管**浏览器里哪个页面能碰这台引擎**；本机任意进程都能读写地址簿里所有仓、改模型端点、发起导入，也停得了任何回合。「谁能用这台引擎」这件事从此等于「谁能登这台机器」。
- 全局面不再按人过滤：`GET /api/events` 的逐帧 ACL 随身份一起没了，而帧里带着目标仓的绝对路径与改动文件名。
- `llm.log` 与 `engine.jsonl` 的 `actor` 这列**新行恒 null**——字段保留，两份 JSONL 的列形状不能变，历史行里有值。`pnpm dataflow:report` 的 `--actor` 那档删了（留着就是一格永远为空的读数）。
- 界面不再有「引擎访问口令」那一行，所有请求都不带 `x-api-key`；`/api/health` 也不再报 `auth` 字段。
- 与认证无关、**一字未动**的几道闸：沙箱隔离探测没过就整域禁用代码题（fail-closed）、出境前密钥筛 `security/secrets.ts`、`code_egress` 出境审计线与 journal 写入权分表、月度预算闸、源码读取的仓内边界与软链接复核、`GET /source` 的拒读名单。

GUI 走的全是相对路径（`/api/...`），所以本机默认形态就是**同源**（dev 由 vite 代理转发）；同源下浏览器根本不做跨来源检查，「响应带 `access-control-allow-origin`」只在真把界面和引擎拆成两个来源时才有意义。导入进度那条事件流仍然是 `fetch` 读流——原先换掉 `EventSource` 是为了带认证头，那个理由随认证闸一起没了，留下是因为三条流共用同一套读流、退避与 `AbortSignal` 语义：指数退避 1s→2s→4s→8s→16s、20s 封顶，外加一条 75s 空闲看门狗（引擎死了而中间代理还替它挂着连接时，读流永远不报错，只能靠「该有帧却没帧」判死）。验证另一台引擎时用 `VITE_ENGINE_ORIGIN` 换 dev 代理目标，不必停手上那个引擎。


常用命令：

```sh
pnpm test        # engine 单测（vitest）
pnpm build       # 全量构建
pnpm lint        # tsc --noEmit
pnpm test:e2e    # Playwright 端到端
pnpm --filter @codebase-tutor/engine exec tsx src/scripts/arch-blocks.ts <仓库路径>    # 零 token 数画布节点（也可 cd packages/engine && pnpm arch:blocks …）
```
