# Phase 0 验证材料

本目录把 M0.4 中需要真人判断的环节明确分开，避免把工程输出误当作研究结论。

- `interview-protocol.md`：5-10 位参与者的出声思维访谈流程。
- `coding-sheet.csv`：转录编码模板，用于记录奇怪比喻、自造词汇与理解伤害。
- `blind-rating-sheet.csv`：三档风格去标识化材料的配对评价表。

先以冻结测试仓库执行：

```sh
pnpm phase0:prepare-study -- /absolute/path/to/frozen-repository
pnpm phase0:audit -- /absolute/path/to/frozen-repository
```

两条命令分别在目标仓库产生 `.tutor/studies/style-blind-materials.json` 和 `.tutor/audits/selection-explanations.json`。研究者填写本目录的表格后，再由阶段负责人判断 M0 Gate 是否成立；当前项目不会声称 Gate 已通过。
