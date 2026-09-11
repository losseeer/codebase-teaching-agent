# Codebase Tutor

本地运行的代码库教学 Agent。导入一个仓库后，它会建立文件与热点索引、生成带源码锚点的宏观和微观课程树、影响半径、选型证据与可调教学会话。

## Quick start

```sh
pnpm install
pnpm dev
```

打开 `http://localhost:3000`，在导入页填入待学习仓库的绝对路径。分析结果、SQLite 数据库及不可变学习日志都会保存在该仓库的 `.tutor/` 目录。

未配置模型服务时，应用使用内置的确定性摘要与教学后备，因此完整工作流不需要 API 密钥。设置 `TUTOR_SUMMARY_PROVIDER=ollama` 可使用本机 Ollama；不可用时会逐文件降级回确定性摘要。

教学会话可通过统一 Provider 接入真实模型：

```bash
# OpenAI
TUTOR_TEACHING_PROVIDER=openai OPENAI_API_KEY=... TUTOR_TEACHING_MODEL=gpt-4o-mini pnpm dev
# 无密钥的本机 OpenAI-compatible 服务（例如 LM Studio）
TUTOR_TEACHING_PROVIDER=openai-compatible TUTOR_OPENAI_URL=http://127.0.0.1:1234/v1 TUTOR_TEACHING_MODEL=local-model pnpm dev
# Anthropic
TUTOR_TEACHING_PROVIDER=anthropic ANTHROPIC_API_KEY=... TUTOR_TEACHING_MODEL=claude-3-5-sonnet-20241022 pnpm dev
# Ollama
TUTOR_TEACHING_PROVIDER=ollama TUTOR_TEACHING_MODEL=qwen2.5:7b pnpm dev
```

可选配置 `TUTOR_OPENAI_URL`、`TUTOR_ANTHROPIC_URL`、`TUTOR_OLLAMA_URL` 和 `TUTOR_LLM_TIMEOUT_MS`。Provider 会携带受限 RAG 上下文、重试一次；请求失败、无 API Key 或预算触顶时回到本地教学规则，状态机和日志链路继续运行。`GET /api/health` 会返回当前摘要档和教学档。

## 分析排除规则

首次导入时，引擎会在被导入仓库根目录生成可编辑的 `.tutorignore`，可屏蔽不属于项目教学内容的路径。它支持常用 `.gitignore` 风格的注释、`*`、`?`、`**`、目录后缀和以 `!` 开头的重新纳入规则；初始内容见 [.tutorignore.example](.tutorignore.example)。

生成的默认文件包含 `.claude/`、`.workbuddy/`、`.codex/`、`.cursor/`、`.aider/`、`.continue/` 等 Agent 工作目录，以及 `node_modules/`、构建产物、缓存、覆盖率、`.git/` 和 `.tutor/`。默认行为完全由该文件决定，保存后文件监听器会自动触发重新分析。

## M1 capabilities

- 函数级 ImplementationUnit：输入、输出、不变量、边界和陷阱。
- DecisionUnit：从 manifest、配置、README 和提交历史收集证据，严格区分直接、间接和推测。
- 导入图与调用图的影响半径 API，文件 watch 增量更新，以及 LSP 不可用时的静态分析后备。
- 连续语言风格、教学法和拆解层次的会话内热切换；本地规则 hook 过滤；成本预算降级。
- A/B/C 对照实验配置和 journal CSV 导出。

TypeScript LSP 随引擎安装；Python 项目会在本机存在 `pylsp` 时自动接入，否则显示静态分析后备状态。

## Commands

```sh
pnpm test
pnpm build
pnpm phase0:prepare-study -- /absolute/path/to/repository
pnpm phase0:audit -- /absolute/path/to/repository
```

`phase0:prepare-study` 为三档盲评生成去标识化材料；`phase0:audit` 为 20 条入口/选型解释抽检生成审核表。访谈招募、录音和人工编码模板见 `research/`。
