# Codebase Tutor

[![Version](https://img.shields.io/badge/version-0.1.0-orange)](package.json)
[![License](https://img.shields.io/badge/License-MIT-BD2D2D)](LICENSE)
[![CI](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/losseeer/codebase-teaching-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%20in%20CI-339933?logo=node.js&logoColor=white)](.github/workflows/ci.yml)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.1-F69220?logo=pnpm&logoColor=white)](package.json)

[English](README.en.md) ｜ 本文

## 简介

给它一个仓库路径，它把仓库读成能讲的结构，然后就这个仓库回答你的问题。

读法是静态分析打底：解析出符号级依赖图和逐文件摘要，另算四类确定性产物（控制流图、函数内数据流、类型关系、注册与配置索引）落 `.tutor/` 的 `static_fact` 表——它们不参与任何缓存键，加一类分析不会让已导入的仓为它重付一次模型调用。问答与画结构图都由同一个 agent 完成：它会自己去检索、读文件、查这四类已算好的产物，不靠猜，画布上的模块节点直接指到文件、目录或符号。出题、判分与练习答疑走同一条取证循环：有仓就能自己读文件、检索、查这四类已算好的产物，轮数与读文件数不设实际上限（每轮仍查预算）。主题分解表（四档、每档的可考点与该档在沙箱里判不了的性质）直接并进调用，不必模型自己去取技能；候选摘录还会补一段机制声明（配置键、建表语句、依赖清单）——这类文件不进收录集，不会叫醒摘要。练习分三档题型（理解 / 分析 / 设计），考察主题由用户自建、只用来筛目标单元，不换链路；出过的题进题库，可回看、可删（删题连复习排期一起删，历史记录不动）。

跑在自己机器上，产物写进被分析仓的 `.tutor/`。不配模型也能启动，配了模型按仓库逐次付费，月预算触顶就挡在请求之前。

## 特性

- 导入任意本地仓库：利用静态分析提取项目静态结构用于指导agent教学，可溯源+低token消耗
- 目录排除：`.tutorignore`忽略无关项目文件，只导入核心项目文件
- 三作用域agent：支持项目可视化和模块问答、代码教学、练习与评测
- 纯净教学：只读教学，无coding agent复杂的权限管理与审核，提示词精简
- 自定义教学：可自行装配skill或配置MCP服务，定制agent教学流程 / 风格

## 快速开始

```bash
pnpm install
cp .env.example .env   # 可全部留空：摘要与规则题走确定性档
pnpm dev               # 引擎 127.0.0.1:3001，界面 127.0.0.1:3000
```

打开 `http://127.0.0.1:3000`，填仓库绝对路径导入。引擎自动读取本工具项目根的 `.env`（不是被分析仓的），已存在的环境变量优先；模型、单价与用量在界面的成本页配置。

## License

MIT — 见 [LICENSE](LICENSE)。
