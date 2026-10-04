# `modules/` — 教学模块（业务模块）与练习主题

> 两侧各有一套 chips：**教学侧模块 = 课程树「模块地图」的节点**（跟着仓库走），**练习侧 = 固定「程序理解题」+ 用户自建出题主题**。
> 教学侧只把**覆盖层**写进 localStorage（改名 / 隐藏 / 自建，按仓库分键），模块本体每次从课程树现算。

## 为什么不是「知识模块」了（2026-10-02）

原来这里是三个缺省「知识模块」：计算机网络 / 操作系统 / 语言特性，靠 `shared` 的关键词表 `MODULE_KEYWORDS` 把课程节点归类。这条路在业务仓里先天别扭：

- **学科名不是仓库的原生结构**。`Result.java` 被每条流程共用，关键词归类就把它重复十几遍（真仓 1209 个带锚点节点只对应 168 个文件）；
- **LLM 推荐反复判空**。「操作系统」对业务 controller 的候选池来说撑不起这个主题，模型按提示词输出空数组（判得对），界面于是永远只剩那份规则归类清单；
- 为救它做过一版**工程证据锚点表**（学科概念 → 标识符 / 依赖库），能把三个模块救活，但那是「在猜上再叠一层手写映射」，且需要按语言长期维护。**该层已随本次变更整体删除。**

现在模块跟着仓库走：导入什么仓，就有什么模块。业务名字（`博客与评论 REST 接口`、`缓存与可靠消息工具`）本身就是最好的检索词，不再需要翻译层猜。

## 数据从哪来

| 环节 | 实现 |
|---|---|
| 模块本体 | `courseModules(tree)`：取 `root.children` 里 id 为 `modules` 的分支（engine `coursetree/build.ts` 固定给这个 id），每个子节点 = 一个模块 |
| 模块 id | `module:<目录>`（build 时按锚点目录生成，**跨重新导入稳定**），所以覆盖层按 id 存不会因改名而漂 |
| 文件清单 | `moduleEntries(node)`：本节点锚点 + 子孙锚点，**按 path 去重、保留最浅层那条**；条目带树节点 id，点击即可回查选中（断链自动跳过） |
| 覆盖层 | `loadModuleOverrides(repositoryId)` → `{ renamed, hidden, custom }`，三个键分别落 `codebase-tutor.renamed-modules.<repo>` / `.hidden-modules.<repo>` / `.modules.<repo>` |
| 推荐顺序 | 仍走 `GET /module-entries`（LLM 从该模块的候选里挑最多 5 个并给理由）；LLM 不可用/判空/失败时**直接列模块自己的文件清单**，引擎用 `reason` 说明是哪一种 |
| 选中项 | `codebase-tutor.module.teaching.<repo>`；模块被隐藏或树里没了才回落 |

练习侧不变：`codebase-tutor.practice-modules` 只存自建主题，「程序理解题」是固定项（`COMPREHENSION_MODULE_ID`，出题分派的判据）。

## 面板行为（`ModulesPane.tsx`）

- 模块可能几十个（真仓 35~38 个）：chips 区限高滚动，超过 10 个才出现过滤框。
- chip 上带**文件数**，悬停显示模块职责摘要 + 文件数。
- `treeDerived` 决定文案：教学侧的「删除」实际是**隐藏**（确认框与 toast 都写「隐藏」，并说明点「恢复全部模块」或重新导入会回来）；练习侧的自建主题删除是真删除。
- 「恢复全部模块」= 清空覆盖层（撤销改名、恢复隐藏、清掉自建），有确认框。

## 历史与不可比区间

journal 里 2026-10-02 之前的 `entry_adopted` / `entry_overridden` / `module_switched` 事件，`module` 字段是 `network` / `os` / `lang`，`source` 字段是 `heuristic`；之后是 `module:<目录>` 与 `module_files`。**不迁移历史数据**，模块维度的统计跨这个日期不可比。细节见 `docs/开发关键点问题与解决方案.md` 第二十节。
