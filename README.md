# Codebase Tutor

[![Version](https://img.shields.io/badge/version-0.1.0-orange)](package.json)
[![License](https://img.shields.io/badge/License-MIT-BD2D2D)](LICENSE)
[![CI](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%20in%20CI-339933?logo=node.js&logoColor=white)](.github/workflows/ci.yml)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.1-F69220?logo=pnpm&logoColor=white)](package.json)

中文 ｜ [English](README.en.md)

本地优先的代码学习助手：给它一个仓库路径，它把仓库读成可讲的结构，再就这个仓库回答你的问题。

## 目录

- [特性](#特性)
- [工作区](#工作区)
- [架构](#架构)
- [快速开始](#快速开始)
- [配置](#配置)
- [数据存放](#数据存放)
- [开发](#开发)
- [License](#license)

## 特性

- **静态分析打底**：解析符号级依赖图与逐文件摘要，另算控制流图、函数内数据流、类型关系、注册与配置索引四类确定性产物。它们不进缓存键，加一类分析不会让已导入的仓库重付一次模型调用。
- **Agent 自己取证**：问答与画图共用一条工具循环，Agent 会自行检索、读文件、查静态产物；画布节点可直接指到文件、目录或符号。
- **只读学习**：不做代码改动，没有编码 Agent 的工具权限与审核负担，提示词精简。
- **三工作区**：架构全景、代码问答、练习，共用同一份仓库结构。
- **可定制教学**：支持自建 Skill、配置 MCP 服务、调整教学档位（引导 / 讲解）与用户画像。
- **成本可控**：月预算触顶在请求前拦截；不配模型也能启动，摘要与规则题走确定性档。

## 工作区

| 工作区 | 用途 |
|---|---|
| 架构全景 | 看模块边界、依赖与调用关系，在画布上拖分组和节点、看版本、导出 JSON |
| 代码问答 | 围绕选中的文件或目录问答，按符号锚点取证，支持教学档位与追问 |
| 练习 | 出题、沙箱自证、判分与练习答疑；主题由用户自建，题库可回看与删除 |

## 架构

monorepo，pnpm workspaces + TypeScript：

| 包 | 职责 |
|---|---|
| `packages/analysis` | 语法解析、依赖图、静态事实抽取 |
| `packages/contract` | 前后端共享的 API schema 与类型 |
| `packages/domain` | 领域模型、教学策略与审计事件定义 |
| `packages/engine` | Fastify 服务、导入与重分析、LLM 工具循环、练习沙箱、持久化 |
| `packages/gui` | Vite + React 界面、画布与三工作区 |
| `packages/platform` | 日志、trace、路径与平台适配 |

引擎与界面通过 HTTP / SSE 通信。产物写进被分析仓库的 `.tutor/`，工作日志与模型调用日志写在本工具的数据目录。

## 快速开始

需要 Node.js 22+ 与 pnpm 10.11.1。

```bash
pnpm install
cp .env.example .env   # 可全部留空
pnpm dev               # 引擎 127.0.0.1:3001，界面 127.0.0.1:3000
```

打开 `http://127.0.0.1:3000`，填仓库绝对路径导入。引擎读本工具项目根的 `.env`（不是被分析仓的），已存在的环境变量优先。模型、单价、用量与预算在界面的「管理配置」里设置。

## 配置

完整变量见 [.env.example](.env.example)。常用：

| 变量 | 作用 |
|---|---|
| `TUTOR_LLM_PROVIDER` / `TUTOR_LLM_MODEL` | 服务商与模型；支持 `openai-compatible` 与 `openai` |
| `OPENAI_API_KEY` | 密钥；也可在界面配置，配置只回显掩码 |
| `TUTOR_OPENAI_URL` / `TUTOR_OLLAMA_URL` | 自定义端点；Ollama 用兼容端点 |
| `TUTOR_INPUT_USD_PER_MILLION` 等 | 单价，用于在请求前算预算 |
| `TUTOR_SUMMARY_PROVIDER` | 摘要提供方；不配模型时走确定性档 |
| `ENGINE_PORT` | 引擎端口，默认 3001 |
| `TUTOR_ALLOWED_ORIGINS` | 允许的浏览器来源 |

本地模型无需密钥，按服务商端点的兼容格式配置即可。

## 数据存放

- **被分析仓库 `.tutor/`**：索引、依赖图、摘要、静态事实、题库、画布与 `journal.jsonl`。这是产品数据，随仓走；删除仓库地址簿条目不会删它。
- **本工具数据目录**：画像、模型配置、技能、工作日志与模型调用日志，不属于被分析仓库。

不上传源码，也不替你提交或推送任何改动。

## 开发

```bash
pnpm lint        # 全包类型检查
pnpm test        # 全包单测
pnpm build       # 全包构建
pnpm test:e2e    # Playwright 端到端
```

CI 在 `main` 的 push 与所有 PR 上运行：安装 → lint → test → build → Playwright。

## License

MIT — 见 [LICENSE](LICENSE)。
