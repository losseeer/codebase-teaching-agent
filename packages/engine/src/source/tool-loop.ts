import type { ScopedStreamProgress } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmMessage, LlmProvider, LlmTool, LlmUsage } from "../llm/provider.js";
import { LlmAbortedError, isLlmAborted } from "../llm/provider.js";
import { addUsage } from "../llm/usage.js";
import type { McpCallAudit } from "../mcp/clients.js";
import { READ_FILE_TOOL, executeReadFile, type FileReadRecord } from "./read-file.js";
import { SEARCH_CODE_TOOL, executeSearchCode, type CodeSearchRecord, type SearchCorpus } from "./search-code.js";

/**
  read_file / search_code 工具循环（宏观设计 map 与教学 teaching 两个作用域共用）：

  - 预算硬上限（轮数 / 累计**读成功**的文件数）；用尽时对未应答的 tool_call 明确回绝，再做一轮不带工具的收尾回答。
    被护栏拒绝或路径写错的调用**不占文件额度**（代价只有一行文本，且「反复乱试」已由轮数兜住），但仍逐条进 fileReads 审计；
  - 传入 `search` 语料时额外提供 search_code（词法检索「文件在哪」，只回位置与职责）：
    它不读任何文件，**不占文件额度也不记 file_read**，单独进 codeSearches 审计；轮数上限同样约束它；
  - messages[0] 恒为首轮 user 消息——provider 提供 messages 时忽略 user 字段，
    首轮 user 若不进 messages，工具调用后的轮次会同时丢失代码上下文与学习者提问（回归防线）；
  - 每轮调用前 micro_compact：更早轮次的 tool 结果压成占位符、早期 reasoningContent 丢弃
    （读取结果可再生，推理 token 是账单大头）；最近一轮 assistant 的 reasoningContent 保留（部分协议要求回传）；
  - 每次 read_file（含拒绝与失败）返回审计记录，由调用方记 journal file_read。
  - `signal` 透传到每一轮 LLM 调用，并在开新一轮前检查：中止一律抛 LlmAbortedError 原样上抛，
    不吞成「基于已有上下文直接回答」的收尾结论（那会把用户主动停止伪装成模型答完）。
  */

/**
  工具循环的过程事件。形状**从帧词表里取**（`shared` 的 `ScopedStreamProgress`）：
  宏观设计与练习那两条流是把这三类直接当 SSE 帧发出去的，两处各写一份字面量迟早漂——
  漂了以后引擎在发一种界面不认识的帧，屏幕上只剩「回复生成中…」（10-06 的 `thinking` 漏接就是这个形状）。
*/
export type ReadToolProgress = Extract<ScopedStreamProgress, { type: "thinking" | "reading" | "searching" }>;

export interface ReadToolLoopInput {
  provider: LlmProvider;
  /** 仓库根：read_file 只能在此范围内读取 */
  repoPath: string;
  system: string;
  /** 首轮 user 消息（代码上下文 + 学习者提问） */
  user: string;
  maxTokens: number;
  temperature: number;
  maxRounds: number;
  /** 本次对话累计最多读取几个文件（只数读成功的；被拒绝/失败的仍进 fileReads 审计但不占额度） */
  maxCalls: number;
  onProgress?: (progress: ReadToolProgress) => void;
  /** LLM 工作日志的场景标签（teaching.turn / map.chat），透传给每一轮调用 */
  scene?: string;
  /** 提供时额外开放 search_code 工具（词法检索定位文件）；不提供则模型只有 read_file。 */
  search?: SearchCorpus;
  /** 外部中止信号：透传给每一轮 LLM 调用，并在进入下一轮前检查（读文件是本地操作，不在此列）。 */
  signal?: AbortSignal;
  /** 跨仓访问：见 `CrossRepoContext`。不传 = 只有当前仓，工具清单与从前逐字一致。 */
  cross?: CrossRepoContext;
  /**
    架构修正工具（唯一的有副作用工具）。不传 = 这个作用域没有写能力，
    工具清单里连 `set_architecture` 这个节点都不出现——practice_chat 与教学回合就是这种（map 作用域每轮都给，见 `server.ts` 的 `architectureToolFor`）。
  */
  architecture?: ArchitectureToolContext;
  /**
    画布上那张图的结构改动（第二个有副作用的工具，2026-10-18 与 `set_architecture` 同一道作用域闸）。
    不传 = 这个作用域没有改图的权力，清单里连 `set_diagram` 这个节点都不出现——只有 map 作用域给，
    教学与练习两张脸都不给：它们面对的是代码与题目，不是画布。
  */
  diagram?: SetDiagramToolContext;
  /**
    技能正文的取用通道（2026-10-17）。不传 = 工具清单里没有 `read_skill`，
    系统提示词也不该出现技能清单——清单与通道必须同时给或同时不给，只给一半就是让模型找一个不存在的工具。
  */
  skills?: SkillsToolContext;
  /**
    外部 MCP 工具面（2026-10-17）。**默认不给**：每一条外部工具的 schema 都要进每一轮请求的 token，
    还会改变请求前缀的形状（前缀缓存按请求头部算）。服务层只在配置文件里真有启用的 server 时才传。
  */
  external?: ExternalToolContext;
}

/** 技能通道：清单（`brief`）与取正文的通道必须同时给或同时不给——只给一半就是让模型找一个不存在的工具。 */
export interface SkillsToolContext {
  /** 进上下文的那段清单（名字 + 一句描述 + 「先取正文再照做」那句约束）。 */
  brief: string;
  /**
    取正文（`file` 省略 = `SKILL.md`）或该技能目录里的附属文件（规格第三层：正文用相对路径引用它们）。
    回 `undefined` = 没这个技能或没这个文件；工具把这句话照实回给模型，不编一段看着像正文的东西。
  */
  bodyOf: (name: string, file?: string) => string | undefined;
}

/**
  外部 MCP 工具面。清单与调用都由服务层实现，本循环不认识 SDK、也不认识子进程。

  ⚠️ `call` **不许抛**：外部 server 是别人写的程序，超时、崩了、回了错误都得变成一句给模型看的实话，
  否则一个第三方故障会把整个回合掀掉（学习者只看到报错，还不知道是哪一环节掉的）。
*/
export interface ExternalToolContext {
  /** 已带 `mcp__<server>__<tool>` 前缀的清单，直接并进本轮工具数组。 */
  tools: LlmTool[];
  call: (name: string, argumentsJson: string) => Promise<{ text: string; audit: McpCallAudit }>;
  /** 一个回合最多打几次外部调用（默认 3）。读文件额度是本地事实的额度，外部的不算进去。 */
  maxCalls?: number;
}

/** 技能正文的取用工具：清单常驻上下文，正文按需拉取，成本差一个数量级。 */
export const READ_SKILL_TOOL: LlmTool = {
  name: "read_skill",
  description: "按名字取一份技能的完整正文（系统提示词里那张清单上的名字）。做法、命令与红线都在正文里——只凭名字猜内容会猜错。正文提到的附属文件（脚本、参照表之类）用 file 参数按相对该技能目录的路径取。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "清单上的技能名字" },
      file: { type: "string", description: "可选：技能目录内的相对路径，省略就取 SKILL.md 正文" }
    },
    required: ["name"]
  }
};

/**
  跨仓访问上下文。**只在地址簿里还有别的仓时才传**——没有第二个仓时三个工具一个都不多给，
  工具清单与提示词逐字不变（多一段没用的清单就是每轮白付 token，还会让模型去猜不存在的对端）。

  - `roots`：仓名 → 仓库根路径。`read_file` 靠它换根，**守卫整套复用**（仓内边界、拒读名单、软链接复核都在根路径这一层）；
  - `corpusOf`：仓名 → 检索语料，**模型真搜时才现取**（取一份对端语料意味着要把那个仓挂进内存，不该为「它可能问一句」先付）；
    回 `undefined` 表示这仓没产物、只能读不能搜，工具会照实回一句，不让模型以为工具坏了；
  - `links`：当前仓 ↔ 对端仓按归一化 URL 配好的接缝清单（零 token 实时计算，代价是读两边源码，所以只在模型真调用时才算）。
  */
export interface CrossRepoContext {
  roots: Record<string, string>;
  corpusOf?: (repoName: string) => SearchCorpus | undefined;
  links?: (repoName: string, filter: string) => string;
  /** 跨仓读取的独立上限：总额度之外再掐一道，防止模型把两个仓都翻一遍。 */
  maxCrossReads?: number;
  /** 每递出一份对端内容就回报一次（仓名 + 该仓内的裸路径）。回合收尾的引用复检靠它留痕：见 `server.ts` 的 `recheckTurn`。 */
  onHandedOut?: (repoName: string, path: string) => void;
}

/** 跨仓接缝查询工具：把「点这个按钮之后代码在哪个仓的哪一行」这条零 token 的证据交给模型。 */
export const CROSS_REPO_LINK_TOOL: LlmTool = {
  name: "cross_repo_link",
  description: "查询当前仓库与另一个仓库之间按 URL 配好的 HTTP 接缝：本仓调用的地址落在对端哪个文件哪一行，以及对端提供了哪些地址被本仓调用。回答跨仓「这个请求打到哪里去」时先调用它拿准确落点，不要靠猜 URL 字符串。",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "对端仓库名" },
      filter: { type: "string", description: "只看包含该片段（路径或 URL 片段）的接缝，可选" }
    },
    required: ["repo"]
  }
};

/**
  人工修正通道的工具面（全仓第一个**有副作用**的工具，2026-10-16）。
  ⚠️ 参数表里没有边、没有文件、没有模块的增删——**不是忘了加，是刻意不给**：
  跨层箭头由 import 聚合而来，任何「模型说有一条 A→B 的边」都不可能被证据支持。
  写侧（scopechat 传进来的闭包）再做一次白名单校验，两层都要挡住改边这条路。
*/
export const SET_ARCHITECTURE_TOOL: LlmTool = {
  name: "set_architecture",
  description: "修正架构视图的分层判断，四种动作：move_module（给 module+layer，把图上那个节点挪进某层）、rename_layer（给 from+to，给层改名）、set_tier（给 module+tier，改某模块的结构档）、reset（撤销人工修正）。reset 有三种撤法，按给几个参数分：给 module 只撤那个节点的归层与改档；给 from 或 to 只撤一条层名改名（原判名或改后的名字都认）；两个都不给＝把这个仓**所有**修正一次清空——不是「撤销刚才那条」的意思，只有用户明确说要全清时才这么调。module 用上下文里那张节点清单上的 id（arch: 开头是组合节点，整块走；module: 开头是单个模块）。只能改「层怎么归」这类判断题；箭头、模块清单、文件路径都由程序按 import 算，改不了，也不要试图在这里改。",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "move_module / rename_layer / set_tier / reset" },
      module: { type: "string", description: "图上那个节点的 id：组合节点 arch: 开头（整块挪），原子模块 module: 开头（set_tier 只认这一档；reset 给了它就只撤这个节点）" },
      layer: { type: "string", description: "目标层名（move_module 必填）" },
      from: { type: "string", description: "rename_layer 的原层名；reset 时给它就是「只撤这条改名」" },
      to: { type: "string", description: "rename_layer 的新层名（1~24 字）；reset 时给它就是「只撤改成这个名字的那条改名」" },
      tier: { type: "string", description: "core / facility / periphery（set_tier 必填）" }
    },
    required: ["action"]
  }
};

/** 副作用工具的落地通道：由服务层给一个闭包，工具循环不认识数据库与 journal。 */
export interface ArchitectureToolContext {
  /**
    执行一次修正并回一句给模型看的话（写成/写成什么、或拒写原因）。
    返回文本会作为 `role:"tool"` 的结果回喂，模型下一轮就按它说——所以这里必须回**实际落盘后的状态**，
    不能回「意图」：回错了模型会把没改成的说成改成了。
  */
  apply: (argumentsJson: string) => string;
  /**
    现在的分层现场 + 已存的人工修正清单（一段文本，由作用域层进上下文）。
    为什么要有这个节点：修正存在引擎里，横幅读得到、模型读不到——用户说「撤掉那条」时，
    模型手上既没有「哪一条」的清单，也没有节点 id，只能猜或反问（2026-10-16 用户指出）。
  */
  inventory?: string;
}

/**
  画布上「结构」的写入口（2026-10-18，与 `set_architecture` 并列为全仓仅有的两个有副作用的工具）。
  描述里把那四条纪律写死，而不是留在提示词里劝：
  ① 位置是用户的（不让动就别动，`move` 只在用户开口时代挪一格）；
  ② `module` 节点必须带真 `ref`，核不上整次拒写；
  ③ 边的 `origin` 引擎会拿三张结构表核，**只降不升**，降完把原因写在边上；
  ④ `draw` 一次交整张图，别一格一格试（图库里一张图 = 一个能讲清楚的问题）。
*/
export const SET_DIAGRAM_TOOL: LlmTool = {
  name: "set_diagram",
  description: "改画布上那一张图的结构，只有九种动作：draw（一次画完整张图：给 name 与 body={groups,nodes,edges}，会新建一张图进图库）、add_node（给 node）、remove_node（给 target，连带删掉挂在它身上的边）、add_edge（给 edge）、remove_edge（给 target）、add_group（给 group）、remove_group（给 target，框里节点的归属一并清掉）、relabel（给 target 与 label/sub/text）、move（给 target 与 x、y）。三条硬规矩：**① 位置是用户的**，除非用户明确让你摆，别去挪东西（用户自己拖不存版本）；**② kind=module 的节点必须带 ref**，指课程树里的模块 id 或上下文那份画布现场上的 arch: 方块 id，指不到就不落笔——画一个查无此人的节点，读者会去代码里找它；**③ 边的 origin 你可以报 static 或 code，引擎会拿 import、调用、类型派发三张表逐条核，核不到就降成 inferred 并把为什么写在边上（它只会降不会升，也别试图自己写 downgraded，那一格由引擎填）**。要改哪张图就写 diagram（id 或名字），省略＝只有一张时的那张；上下文里那份「画布现场」列了现有的图与正打开那张的全部图元 id，照着它写，别猜 id。",
  parameters: {
    type: "object",
    properties: {
      diagram: { type: "string", description: "要改的那张图：id 或名字。省略时如果这个仓只有一张图就用它，认不出会被拒并列出图库" },
      edit: { type: "object", description: "一次改动：{ action, ...该动作的字段 }。action 取 draw / add_node / remove_node / add_edge / remove_edge / add_group / remove_group / relabel / move；node={id,kind:module|note,label,x,y,sub?,group?,module 再带 ref,note 再带 text}，edge={id,from,to,origin:static|code|inferred,label?,evidence?}，group={id,label,x,y,w,h}，body={groups,nodes,edges}" }
    },
    required: ["edit"]
  }
};

/**
  改这张图的落地通道：由服务层给闭包，工具循环不认识数据库、journal 与课程树。
  与 `ArchitectureToolContext` 同一条纪律：回的是**实际落盘后的状态**（或拒写的那句原因），
  不是意图——回错了模型就会把没改成的说成改成了。`inventory` 是「画布现场」，
  有副作用的工具必须先看得见现状（§71），否则它只能猜 id、猜「那条边」到底指哪条。
*/
export interface SetDiagramToolContext {
  apply: (argumentsJson: string) => string;
  inventory?: string;
}

/** 按「有没有第二个仓」现做工具清单：跨仓参数与 cross_repo_link 只在真有对端时出现。 */
function toolsFor(withSearch: boolean, cross?: CrossRepoContext, architecture?: ArchitectureToolContext, diagram?: SetDiagramToolContext, skills?: SkillsToolContext, external?: ExternalToolContext): LlmTool[] {
  const names = cross ? Object.keys(cross.roots) : [];
  const withRepo = (tool: LlmTool, extra: string): LlmTool => {
    const properties = (tool.parameters.properties ?? {}) as Record<string, unknown>;
    return {
      ...tool,
      description: `${tool.description} 跨仓时给 repo 参数（${extra}），省略即当前仓。`,
      parameters: { ...tool.parameters, properties: { ...properties, repo: { type: "string", description: `其他仓的名字，可选；本仓请省略。可用值：${names.join(" / ")}` } } }
    };
  };
  const tools: LlmTool[] = [names.length ? withRepo(READ_FILE_TOOL, "读对端实现") : READ_FILE_TOOL];
  if (withSearch) tools.push(names.length ? withRepo(SEARCH_CODE_TOOL, "在对端仓里定位文件") : SEARCH_CODE_TOOL);
  if (cross?.links) tools.push(CROSS_REPO_LINK_TOOL);
  // 写侧工具只在服务层给了闭包时才出现：practice_chat 与没绑定模块的回合都不该有这个能力
  if (architecture) tools.push(SET_ARCHITECTURE_TOOL);
  if (diagram) tools.push(SET_DIAGRAM_TOOL);
  if (skills) tools.push(READ_SKILL_TOOL);
  // 外部工具原样并进清单：描述里已带「【外部 <server>】」前缀，模型分得清这是别人的程序
  if (external?.tools.length) tools.push(...external.tools);
  return tools;
}

/** 取参数里的一个字符串字段（选仓、接缝过滤都用它；解析失败一律回空串，按默认路径走）。 */
function readArg(argumentsJson: string, key: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
    return typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "";
  } catch {
    return "";
  }
}

/**
  回合被中止时随异常带走的「这一轮真做过什么」：中止按作废收尾（不落正文、不回放、不写 turn_text），
  但读过的文件、搜过的查询、打过的外部工具是**已经发生的事实**——钱花了、内容出过门。
  跟着异常一起丢掉，journal 就留下一行「这一轮什么都没干」的假账（§77 第 6 条）。
  走 symbol 键：provider 与 GUI 都不该看见这份旁证。
*/
export interface ToolLoopAudits {
  fileReads: FileReadRecord[];
  codeSearches: CodeSearchRecord[];
  skillReads: { skill: string; chars: number; found: boolean }[];
  mcpCalls: McpCallAudit[];
  rounds: number;
}

const auditsKey = Symbol("codebaseTutor.toolLoopAudits");

export function toolLoopAuditsOf(error: unknown): ToolLoopAudits | undefined {
  return error && typeof error === "object" ? (error as Record<symbol, unknown>)[auditsKey] as ToolLoopAudits | undefined : undefined;
}

function attachToolLoopAudits(error: unknown, audits: ToolLoopAudits): void {
  if (!error || typeof error !== "object") return;
  (error as Record<symbol, unknown>)[auditsKey] = audits;
}

export interface ReadToolLoopResult {
  completion: LlmCompletion;
  usage?: LlmUsage;
  /** 实际发生的工具调用轮数（预算上限打满提前收尾的轮也算）。 */
  rounds: number;
  fileReads: FileReadRecord[];
  /** 本次对话的 search_code 调用审计（不合并去重——同一查询反复搜本身就是信号）。 */
  codeSearches: CodeSearchRecord[];
  /** 取过的技能正文。`found: false` 也记：模型在清单上找一个不存在的技能，是这份清单与提示词漂移的读数。 */
  skillReads: { skill: string; chars: number; found: boolean }[];
  /** 外部 MCP 工具的实际调用（一条一次，失败也记）。正文不在这里，只有字符数与指纹。 */
  mcpCalls: McpCallAudit[];
}

export async function completeWithReadTool(input: ReadToolLoopInput): Promise<ReadToolLoopResult> {
  const { provider, system, maxTokens, temperature } = input;
  const tools = toolsFor(Boolean(input.search), input.cross, input.architecture, input.diagram, input.skills, input.external);
  const available = tools.map((tool) => tool.name).join(" 与 ");
  const crossNames = input.cross ? Object.keys(input.cross.roots) : [];
  const messages: LlmMessage[] = [{ role: "user", content: input.user }];
  input.onProgress?.({ type: "thinking", round: 1 });
  let completion = await provider.complete({ system, user: input.user, tools, maxTokens, temperature, scene: input.scene, signal: input.signal });
  const fileReads: FileReadRecord[] = [];
  const codeSearches: CodeSearchRecord[] = [];
  const skillReads: { skill: string; chars: number; found: boolean }[] = [];
  const mcpCalls: McpCallAudit[] = [];
  let usage: LlmUsage | undefined = completion.usage;
  let rounds = 0;
  let succeededReads = 0;
  let crossReads = 0;
  let externalCalls = 0;
  const audits = (): ToolLoopAudits => ({ fileReads, codeSearches, skillReads, mcpCalls, rounds });
  try {
  while (completion.toolCalls?.length) {
    // 中止检查点：上一轮的 LLM 已返回，若此时用户已经停了，就绝不再开新一轮（也不落收尾调用）。
    if (input.signal?.aborted) throw new LlmAbortedError();
    if (rounds >= input.maxRounds || succeededReads >= input.maxCalls) {
      messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
      for (const call of completion.toolCalls) {
        messages.push({ role: "tool", toolCallId: call.id, content: "已达到本次对话的读文件上限，请基于已有上下文直接回答。" });
      }
      input.onProgress?.({ type: "thinking", round: rounds + 2 });
      compactToolHistory(messages);
      completion = await provider.complete({ system, messages, maxTokens, temperature, scene: input.scene, signal: input.signal });
      usage = addUsage(usage, completion.usage);
      break;
    }
    rounds += 1;
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
    for (const call of completion.toolCalls) {
      if (call.name === CROSS_REPO_LINK_TOOL.name) {
        // 零 token 实时计算：代价是读两边源码（几十毫秒），所以只在模型真开口要跨仓落点时才算一次
        const repo = readArg(call.argumentsJson, "repo");
        const content = !input.cross?.links ? "当前没有可配对的其他仓。"
          : !crossNames.includes(repo) ? `未知仓库「${repo}」；可配对的其他仓：${crossNames.join(" / ")}`
            : input.cross.links(repo, readArg(call.argumentsJson, "filter"));
        messages.push({ role: "tool", toolCallId: call.id, content });
        continue;
      }
      if (call.name === SEARCH_CODE_TOOL.name && (input.search || input.cross?.corpusOf)) {
        const repo = readArg(call.argumentsJson, "repo");
        const corpus = repo ? input.cross?.corpusOf?.(repo) : input.search;
        if (!corpus) {
          // 说清「这个仓能读不能搜」，否则模型会以为工具坏了而反复重试；不占任何额度
          messages.push({ role: "tool", toolCallId: call.id, content: repo
            ? `仓「${repo}」没有可检索的产物（可能还没导入完成），但可以用 read_file 带 repo="${repo}" 直接读它的文件。`
            : "当前作用域未开放 search_code。" });
          continue;
        }
        input.onProgress?.({ type: "searching", query: readQueryHint(call.argumentsJson) });
        const outcome = executeSearchCode(corpus, call.argumentsJson);
        codeSearches.push(repo ? { ...outcome.audit, query: `${outcome.audit.query}（仓 ${repo}）` } : outcome.audit);
        messages.push({ role: "tool", toolCallId: call.id, content: outcome.content });
        continue;
      }
      if (call.name === SET_ARCHITECTURE_TOOL.name) {
        if (!input.architecture) {
          messages.push({ role: "tool", toolCallId: call.id, content: "当前作用域没开放架构修正。" });
          continue;
        }
        // 副作用一次就回一句实话；不占读文件额度（它读的是产物，不是源码）
        messages.push({ role: "tool", toolCallId: call.id, content: input.architecture.apply(call.argumentsJson) });
        continue;
      }
      if (call.name === SET_DIAGRAM_TOOL.name) {
        // 结构改动一次一回执（落成了什么、被降了几条边、或为什么整次拒写）。不占读文件额度：它读的是产物不是源码
        messages.push({ role: "tool", toolCallId: call.id, content: input.diagram?.apply(call.argumentsJson) ?? "这个作用域没有改这张图的权力。" });
        continue;
      }
      if (call.name === READ_SKILL_TOOL.name && input.skills) {
        const skill = readSkillHint(call.argumentsJson);
        const file = readSkillFileHint(call.argumentsJson);
        const body = input.skills.bodyOf(skill, file);
        // 「取到了但正文是空的」与「没有这份技能」是两个读数：前者的做法确实装了、只是没写内容，
        // 用 Boolean(body) 会把前者判成后者，模型于是回用户一句「这个技能不存在」——那是假话
        const found = body !== undefined;
        skillReads.push({ skill: file ? `${skill}/${file}` : skill, chars: body?.length ?? 0, found });
        messages.push({ role: "tool", toolCallId: call.id, content: found ? (body || "（这份技能装好了，但正文是空的：只有 frontmatter，没有可照做的步骤。）") : `没有「${skill}」这份技能${file ? `或它目录里的 ${file}` : ""}；清单上的名字以外都不要用。` });
        continue;
      }
      if (input.external?.tools.some((tool) => tool.name === call.name)) {
        const cap = input.external.maxCalls ?? 3;
        if (externalCalls >= cap) {
          // 照实说上限，别让模型以为外部工具坏了而反复重试（与 corpusOf「这仓能读不能搜」同一条纪律）
          messages.push({ role: "tool", toolCallId: call.id, content: `外部工具一个回合最多打 ${cap} 次，额度已用完。请基于已拿到的外部内容回答，并说明哪些部分没核实。` });
          continue;
        }
        externalCalls += 1;
        // 外部 server 是别人写的程序：call 里任何失败都已转成一句实话，这里不允许抛出（抛出会掀掉整个回合）
        const outcome = await input.external.call(call.name, call.argumentsJson);
        mcpCalls.push(outcome.audit);
        messages.push({ role: "tool", toolCallId: call.id, content: outcome.text });
        continue;
      }
      if (call.name !== READ_FILE_TOOL.name) {
        messages.push({ role: "tool", toolCallId: call.id, content: `未知工具 ${call.name}；只支持 ${available}。` });
        continue;
      }
      const repo = readArg(call.argumentsJson, "repo");
      const root = repo ? input.cross?.roots[repo] : input.repoPath;
      if (!root) {
        messages.push({ role: "tool", toolCallId: call.id, content: `未知仓库「${repo}」；可访问：当前仓${crossNames.length ? ` / ${crossNames.join(" / ")}` : "（地址簿里没有其他仓，跨仓请省略 repo 参数）"}。` });
        continue;
      }
      if (repo && crossReads >= (input.cross?.maxCrossReads ?? 2)) {
        messages.push({ role: "tool", toolCallId: call.id, content: `跨仓读取最多 ${input.cross?.maxCrossReads ?? 2} 个文件，额度已用完。请基于已读到的对端内容回答，并说明哪些部分没核实。` });
        continue;
      }
      input.onProgress?.({ type: "reading", path: repo ? `${repo}/${readPathHint(call.argumentsJson)}` : readPathHint(call.argumentsJson) });
      const outcome = executeReadFile(root, call.argumentsJson);
      // 审计与正文都要带上仓名：journal 的 file_read 只有一个 path 字段，不带仓名就分不出这是哪个仓的文件
      fileReads.push(repo ? { ...outcome.audit, path: `${repo}/${outcome.audit.path}` } : outcome.audit);
      if (!outcome.audit.denied) {
        succeededReads += 1;
        if (repo) {
          crossReads += 1;
          input.cross?.onHandedOut?.(repo, outcome.audit.path);
        }
      }
      messages.push({ role: "tool", toolCallId: call.id, content: repo ? `【来自仓 ${repo}】\n${outcome.content}` : outcome.content });
    }
    input.onProgress?.({ type: "thinking", round: rounds + 1 });
    compactToolHistory(messages);
    completion = await provider.complete({ system, messages, tools, maxTokens, temperature, scene: input.scene, signal: input.signal });
    usage = addUsage(usage, completion.usage);
  }
  return { completion, usage, rounds, fileReads, codeSearches, skillReads, mcpCalls };
  } catch (error) {
    if (isLlmAborted(error)) attachToolLoopAudits(error, audits());
    throw error;
  }
}

/** 读取 read_skill 参数里的 name（仅用于审计与回话；解析失败按空名走，工具会回「没有这份技能」）。 */
function readSkillHint(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name.trim() : "";
  } catch {
    return "";
  }
}

/** 读取 read_skill 参数里的 file（附属文件相对路径；没给就取正文）。 */
function readSkillFileHint(argumentsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { file?: unknown };
    const file = typeof parsed.file === "string" ? parsed.file.trim() : "";
    return file || undefined;
  } catch {
    return undefined;
  }
}

/** 读取 read_file 参数里的 path（仅用于进度提示，不参与校验）。 */
function readPathHint(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { path?: unknown };
    return typeof parsed.path === "string" ? parsed.path : "";
  } catch {
    return "";
  }
}

/** 读取 search_code 参数里的 query（仅用于进度提示，不参与校验）。 */
function readQueryHint(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { query?: unknown };
    return typeof parsed.query === "string" ? parsed.query : "";
  } catch {
    return "";
  }
}

/** micro_compact（借鉴 Claude Code s06 的分级压缩）：发给下一轮前，只保留最近一轮的 tool 结果原文，
    更早轮次的 tool 内容替换为短占位符（模型忘了可再次调用 read_file 重取——结果可再生，不值得逐轮重付）；
    早期 assistant 的 reasoningContent 一并丢弃（后续轮不需要重放思考，推理 token 是账单大头）。
    最近一轮 assistant 的 reasoningContent 保留——部分协议要求 tool 调用轮回传 reasoning_content。 */
export function compactToolHistory(messages: LlmMessage[], placeholderChars = 240): void {
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant" && messages[index].toolCalls?.length) {
      lastAssistant = index;
      break;
    }
  }
  if (lastAssistant <= 0) return;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (index < lastAssistant && message.role === "assistant") message.reasoningContent = undefined;
    if (index < lastAssistant && message.role === "tool" && message.content.length > placeholderChars) {
      message.content = `${message.content.slice(0, placeholderChars)}\n…（早期读取结果已省略以控制上下文，需要完整内容可再次调用 read_file。）`;
    }
  }
}
