# Codebase Tutor

[![Version](https://img.shields.io/badge/version-0.1.0-orange)](package.json)
[![License](https://img.shields.io/badge/License-MIT-BD2D2D)](LICENSE)
[![CI](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%20in%20CI-339933?logo=node.js&logoColor=white)](.github/workflows/ci.yml)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.1-F69220?logo=pnpm&logoColor=white)](package.json)

[English](README.en.md) ｜ 本文

## 简介

给它一个仓库路径，它把仓库读成能讲的结构，然后就这个仓库回答你的问题。

读法是静态分析打底：解析出符号级依赖图和逐文件摘要，另算四类确定性产物（控制流图、函数内数据流、类型关系、注册与配置索引）落 `.tutor/` 的 `static_fact` 表——它们不参与任何缓存键，加一类分析不会让已导入的仓为它重付一次模型调用。问答与画结构图都由同一个 agent 完成：它会自己去检索、读文件、查这四类已算好的产物，不靠猜，画布上的模块节点直接指到文件、目录或符号。出题不走这条检索循环，是出题路由内的单次模型调用。

跑在自己机器上，产物写进被分析仓的 `.tutor/`。不配模型也能启动，配了模型按仓库逐次付费，月预算触顶就挡在请求之前。

## 功能

- 导入任意本地仓库：索引、依赖图、摘要一次跑完，按目录排除用 `.tutorignore`
- 代码教学左栏只放项目目录：选中文件或目录即教学作用域，线程绑定该作用域
- 架构画布是图库加无限画布：拖动与改名自己存，图的节点与连线由 agent 依据代码证据提出并直接落盘，每次结构改动存一版、可回滚
- 练习题三族：规则出的程序理解题确定性判分，LLM 出的理解题由模型按 rubric 比对参考答案（`automatic=false`），代码题由模型出题、在沙箱里真跑测试判分；掌握度与待复习随答题更新
- 对话分宏观设计 / 教学 / 练习三个作用域，各自独立线程，流式输出且可随时中止
- 成本页给按场景 / Provider / 逐日分桶的聚合金额；每一发走 `LlmProvider` 的调用按场景与 token 逐行记在 `~/.codebase-tutor/llm.log`（本机 Ollama 摘要自己 fetch，不进这条线）；看结构、看图、看清单都不计费
- 多仓挂载与文件监听，改动后做影响分析；历史对话与审计事件都落盘可复盘
- 外部工具（MCP）默认不接入：配置文件里没有 server 就一个工具都不加；接了 server，没写 `allowedTools` 就把它报上来的工具全部交给模型，写了才只放行清单内的。技能按业界目录约定读 `~/.codebase-tutor/skills` 与 `~/.claude/skills` 两处（不读被学习仓的目录），正文里出现的密钥一律隐去
- 沙箱隔离用 macOS 自带的 Seatbelt（`/usr/bin/sandbox-exec`），Linux 暂不实现；非 macOS 或探测不过则代码题整域禁用，且在付费之前就把这一域挡下来

## 快速开始

```bash
pnpm install
cp .env.example .env   # 可全部留空：摘要与规则题走确定性档
pnpm dev               # 引擎 127.0.0.1:3001，界面 127.0.0.1:3000
```

打开 `http://127.0.0.1:3000`，填仓库绝对路径导入。引擎自动读取本工具项目根的 `.env`（不是被分析仓的），已存在的环境变量优先；模型、单价与用量在界面的成本页配置。

## License

MIT — 见 [LICENSE](LICENSE)。
