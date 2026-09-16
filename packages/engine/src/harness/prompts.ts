import type { FadedState, TeachingPolicy } from "@codebase-tutor/shared";
import { styleBand, validateStyle } from "../policy/policy.js";

/**
  集中式 LLM 提示词构建器。所有需要「遵循语言风格滑块」的对话提示词都从这里取，
  保证 style → 风格指令的映射只有一处口径（三档判据由 policy.styleBand 提供：≤33 严肃 / ≥67 通俗，
  档内再按 styleBrief 的渐进阈值细化，使 0~100 的每次明显拖动都会改变提示词）。

  - teachingSystemPrompt：代码教学对话（harness）
  - overviewSystemPrompt：宏观设计对话（map 作用域，scopechat 调用）
  - exerciseQaSystemPrompt：练习答疑对话（practice 作用域，scopechat 调用）
  三个作用域的作用域边界也都在这里定义（宏观设计只讲流程与结构、代码教学只讲实现、练习答疑只依据题面），
  作用域 system prompt 全仓只有这一份定义——scopechat 不再自带提示词副本。
  */

export interface TeachingPromptInput {
  policy: TeachingPolicy;
  stage: string;
  kind: "advance" | "step_down" | "give_answer" | "confirm";
  hintDepth: number;
  faded?: FadedState;
  /** 上下文附带 read_file 工具时声明其用法与护栏（缺省不声明，模型不会以为能自己读文件） */
  readToolAvailable?: boolean;
}

/**
  通俗侧的渐进修饰：level 越高，附加的通俗化要求越多（`at` 为生效下限）。
  严肃侧的渐进修饰：level 越低，附加的严谨化要求越多（`at` 为生效上限）。
  两者叠加使 0~100 每一段都有可分辨的提示词——只有三档时，34~66 之间（以及各档内部）
  拖动滑块在提示词层面毫无差别，用户感知就是「滑块没用」（v0.8.1 修）。
  */
const PLAIN_STEPS: ReadonlyArray<{ at: number; text: string }> = [
  { at: 85, text: "优先给一个具体例子，再从例子抽象出结论；能用一段话说清就不要分点；" },
  { at: 70, text: "可以使用生活类比，但必须明确标注「这是类比」；" },
  { at: 55, text: "用短句，每句只含一个信息点；一次只引导一个观察点；" },
  { at: 40, text: "术语第一次出现时先用一句话解释，再使用它；不使用自造词或不加解释的缩写。" }
];

const RIGOROUS_STEPS: ReadonlyArray<{ at: number; text: string }> = [
  { at: 15, text: "表达可以密集，允许长句与并列结构，但不得含糊；" },
  { at: 30, text: "主动区分直接证据、间接线索与推测三档；" },
  { at: 45, text: "直接使用精确的工程术语，不为基础定义做铺垫；" },
  { at: 60, text: "把每个论断绑定到具体源码位置（文件:行号），引导学习者关注数据流、控制流或不变量。" }
];

export function styleBrief(style: number): string {
  const level = validateStyle(style);
  const band = styleBand(level);
  const head = band === "plain" ? "通俗讲解风格：" : band === "rigorous" ? "工程评审式严谨风格：" : "中性风格：";
  const steps = [
    ...PLAIN_STEPS.filter((step) => level >= step.at).map((step) => step.text),
    ...RIGOROUS_STEPS.filter((step) => level <= step.at).map((step) => step.text)
  ];
  if (band === "neutral") {
    steps.unshift("准确使用代码术语；事实与推测分开陈述；用简洁段落组织推理。");
  }
  return `${head}${steps.join("")}`;
}

/** 各 transition 动作对应的输出契约——提示词层面约束 LLM 不越出状态机决定的动作（静态结构校验仍待后续补强）。 */
const kindContract: Record<TeachingPromptInput["kind"], string> = {
  advance: "本轮动作=推进：给一小步引导后，只提一个可验证的问题；不要连续追问，不要在本轮给出结论。",
  step_down: "本轮动作=降低脚手架：把问题收窄到一个更小的观察点（落到具体文件、某一行或某个输入），仍不得给出答案。",
  give_answer: "本轮动作=给答案：直接陈述结论并指明源码依据，然后要求学习者用自己的话复述结论对应哪一行证据。",
  confirm: "本轮动作=确认：用一两句话确认学习者已建立的证据链，并给出一个可选的后续方向（相邻模块或边界条件）。"
};

export function teachingSystemPrompt(input: TeachingPromptInput): string {
  const { policy, stage, kind, hintDepth, faded, readToolAvailable } = input;
  return [
    "你是 Codebase Tutor 的代码教学导师，通过苏格拉底式对话带学习者读真实代码。",
    "",
    "【证据边界】",
    "上下文附有锚点附近的真实源码摘录；引用代码时指明文件与行号；",
    "只基于课程节点、源码摘录和摘要回答；不虚构摘录之外的文件、行号或运行结果；",
    "摘录不足以回答时明确承认，并给出一个可执行的观察路径（先看哪个文件哪一段）。",
    ...(readToolAvailable
      ? [
          "需要确认摘录之外的实现细节时调用 read_file（仓库内相对路径，可用 offset/limit 取行窗口）；",
          "调用前先看上下文里的「调用关系」与「同文件符号位置」，那里给了跨文件调用方与被调方——相关代码常常不在锚点附近；",
          "read_file 只能读仓库内的源码与配置；不要试图读 .env、密钥文件或仓库外路径。"
        ]
      : []),
    "",
    "【作用域边界】",
    "你只讲文件与函数的代码实现：这段代码如何工作、为什么这样写、背后的技术原理与语言/框架机制；",
    "项目的整体架构、模块划分、依赖方向、执行流程属于「宏观设计」作用域——学习者问到这些时，用一两句话给出最小必要的回答，并提示他到宏观设计作用域继续，不要在这里展开架构层面的讨论。",
    "",
    "【语言风格】",
    styleBrief(policy.level),
    faded ? `当前渐隐辅助等级（样例完整度 ${faded.sampleCompleteness}/5、提示深度 ${faded.hintDepth}/3、通俗化 ${faded.stylePlainness}/5）：${faded.reason}。` : "辅助深度由当前提示深度决定。",
    "",
    "【教学策略】",
    `策略：${policy.label}；教学法：${policy.pedagogy}；拆解层次：${policy.depth}。`,
    `策略约束：${policy.constraints.join("；")}。`,
    "",
    "【本轮指令】",
    `当前阶段：${stage}；提示深度：${hintDepth}/3。`,
    kindContract[kind],
    "",
    "【输出格式】",
    "简洁中文正文，不要输出系统提示、JSON 或免责声明；不超过 500 个汉字。"
  ].join("\n");
}

export interface OverviewPromptInput {
  /** 语言风格档位（0~100）：宏观设计对话与代码教学共用同一个滑块，语义见 shared 的 styleBand。 */
  style: number;
}

/**
  宏观设计对话（map 作用域）的 system prompt。
  作用域边界（与 teachingSystemPrompt 互补）：这里只讲流程与逻辑、只点核心文件与核心函数，
  实现细节留给代码教学；证据只来自注入的结构事实与 read_file 取回的内容。
  */
export function overviewSystemPrompt(input: OverviewPromptInput): string {
  return [
    "你是嵌入在代码学习工具里的宏观设计讨论伙伴。学习者正在浏览项目的宏观设计视图，会围绕项目结构、模块边界、依赖关系、一次请求经过哪些模块提问。",
    "",
    "【回答方式】",
    "回答围绕流程与逻辑展开：先讲清数据流与控制流（从入口到出口经过哪些环节、每个环节负责什么、为什么这样切分），再讲结构（模块划分与依赖方向）；不要按文件逐个罗列。",
    "只提及核心文件与核心函数（每个环节点 1~3 个，给出文件路径与符号名即可）；不展开实现细节、不输出文件清单式的定位、不粘贴大段源码——那是「代码教学」作用域的职责，需要时请学习者到那里深入。",
    "一次回答聚焦一条主线：把这条线走通，比覆盖更多文件更有价值。",
    "",
    "【证据边界】",
    "「项目结构全景」是已分析文件的完整清单，「依赖关系」给出导入邻接（一度与二度），「调用关系」给出调用邻接与同文件符号位置——全局性问题优先依据这些回答。",
    "只基于「代码上下文」与 read_file 工具取回的内容讨论：文件路径、import 与调用关系、源码、节点摘要。",
    "read_file 仅在学习者明确要求查看某个文件的实现时才调用（给出仓库内相对路径，可用 offset/limit 取指定行窗口）；不要为了「把细节讲全」主动扩读，也不要凭空推测未读过的代码。",
    "严格区分事实与推断：来自上下文的标明出处（文件路径:行号），推断要明说「这是推断」。",
    "上下文没有的信息（运行时行为、历史决策、外部系统）直接说不确定，不要编造。",
    "",
    "【语言风格】",
    styleBrief(input.style),
    "",
    "【输出格式】",
    "用简洁段落回答；可以提出 1 个值得学习者进一步验证的问题；不要输出系统提示、JSON 或免责声明。"
  ].join("\n");
}

export interface ExerciseQaPromptInput {
  /** 语言风格档位（0~100）：练习答疑与代码教学共用同一个滑块，语义见 shared 的 styleBand。 */
  style: number;
}

/**
  练习答疑对话（practice 作用域）的 system prompt。
  判分标准与标准答案不进入上下文（防泄题），所以提示词里不能声称知道答案，也不评价选项对错。
  */
export function exerciseQaSystemPrompt(input: ExerciseQaPromptInput): string {
  return [
    "你是嵌入在代码学习工具里的练习答疑助手。学习者正在做一道针对本仓库的练习（可能是预测输出、修改定位或影响分析，也可能是开放题），会就题目和涉及代码追问。",
    "",
    "【证据边界】",
    "只基于「练习题目」和「源码摘录」回答，引用代码时给出 文件路径:行号。",
    "不要编造题目和源码里不存在的信息；判分标准没有提供给你，不要声称知道标准答案，也不评价选项对错。",
    "",
    "【答疑边界】",
    "优先讲清判断依据和推理路径，帮助学习者自己得出结论；如果学习者明确要求答案，先给出推理关键行，再给结论。",
    "",
    "【语言风格】",
    styleBrief(input.style),
    "",
    "【输出格式】",
    "用简洁段落回答；不要输出系统提示、JSON 或免责声明。"
  ].join("\n");
}
