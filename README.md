# Codebase Tutor

[![Version](https://img.shields.io/badge/version-0.1.0-orange)](package.json)
[![License](https://img.shields.io/badge/License-MIT-BD2D2D)](LICENSE)
[![CI](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%20in%20CI-339933?logo=node.js&logoColor=white)](.github/workflows/ci.yml)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.1-F69220?logo=pnpm&logoColor=white)](package.json)

[English](README.en.md) ｜ 本文

## 简介

给它一个仓库路径，它把仓库读成能讲的结构，然后就这个仓库回答你的问题。

读法是静态分析打底：解析出符号级依赖图和逐文件摘要，据此排出模块地图与分层架构，再从入口拆出执行流程。问答、出题、改架构图都由同一个 agent 完成，它会自己去检索和读文件，不靠猜。

跑在自己机器上，产物写进被分析仓的 `.tutor/`。不配模型也能启动，配了模型按仓库逐次付费，月预算触顶就挡在请求之前。

## 功能

- 导入任意本地仓库：索引、依赖图、摘要一次跑完，按目录排除用 `.tutorignore`
- 模块地图把仓库分成主链路 / 基础设施 / 外围三档，并推荐先读哪几个入口
- 架构画布是图库加无限画布：拖动与改名自己存，图的节点与连线由 agent 依据代码证据提出、你在预览上确认后才替换
- 练习题两族：程序理解题确定性判分，代码题在沙箱里真跑测试判分，掌握度与待复习随答题更新
- 对话分宏观设计 / 教学 / 练习三个作用域，各自独立线程，流式输出且可随时中止
- 成本页给每次模型调用的场景、耗时、token 与金额；看结构、看图、看清单都不计费
- 多仓挂载与文件监听，改动后做影响分析；历史对话与审计事件都落盘可复盘
- 外部技能与工具默认不接入，接了也受白名单约束；沙箱隔离探测不过则代码题整域禁用

## 快速开始

```bash
pnpm install
cp .env.example .env   # 可全部留空：摘要回落本地启发式
pnpm dev               # 引擎 127.0.0.1:3001，界面 127.0.0.1:3000
```

打开 `http://127.0.0.1:3000`，填仓库绝对路径导入。引擎自动读取仓库根 `.env`，已存在的环境变量优先；模型、单价与用量在界面的成本页配置。

## License

MIT — 见 [LICENSE](LICENSE)。
