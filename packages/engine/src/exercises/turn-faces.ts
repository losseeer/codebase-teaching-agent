import type { ReadToolLoopInput } from "../source/tool-loop.js";

/**
  出题、判分、讲评这几趟共用的取证面。
  形状直接取自工具循环的入参：这几趟与问答回合走同一条循环，不再各有一套特例。
*/
export type ExerciseFaces = Pick<ReadToolLoopInput, "repoPath" | "search" | "facts" | "skills" | "external" | "budgetGuard" | "signal">;
