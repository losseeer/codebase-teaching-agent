# `modules/` — 练习页的自建出题主题

代码教学页不再有模块清单：左栏只有项目目录，作用域是选中的文件或目录（`file:<path>` / `dir:<path>`）。
画布上的模块由 agent 画，节点直接指到文件/目录/符号（或带 `files` 的分组），也不再经过课程树。

这里只剩练习页的主题标签：

| 环节 | 实现 |
|---|---|
| 固定项 | 「程序理解题」= `COMPREHENSION_MODULE_ID`，出题分派的判据 |
| 自建主题 | `local-state.ts` 存在浏览器本地（`codebase-tutor.practice-modules`），不跟仓库走、不参与画布 |
| 选中项 | `codebase-tutor.module.practice`；主题被删时回落 |
| 面板 | `PracticeThemes.tsx`：chips 平铺；改名 / 新增 / 删除 / 恢复默认 |

历史：2026-10-02 之前这里是「知识模块」（计算机网络 / 操作系统 / 语言特性），靠关键词表把课程节点归类；
那条路与课程树一起删除。旧 localStorage 键不做迁移。
