import { Ajv, type ValidateFunction } from "ajv";
import { traceEngine } from "@codebase-tutor/platform";
import { maskSecrets } from "@codebase-tutor/domain";

import type { LlmToolCall } from "../../application/port/llm-provider.js";
import type { ToolContext, ToolDefinition, ToolExposure, ToolOutcome, ToolRegistryLike, ToolTraceStep } from "./types.js";

/** 工具调用：查表、复核、校验、执行、脱敏、轨迹。主循环不再按工具名分支。 */

const RESULT_CHARS = 24_000;
const ajv = new Ajv({ allErrors: false, strict: false });
const validators = new Map<string, ValidateFunction>();

export interface ToolTraceSink {
  round: number;
  onTrace?: (step: ToolTraceStep) => void;
}

/** 每回合额度按工具声明的代价类别判；返回一句回绝理由，`undefined` 表示放行。 */
export type ToolRunGuard = (definition: ToolDefinition) => string | undefined;

export interface ToolInvocation {
  outcome: ToolOutcome;
  definition?: ToolDefinition;
}

export class ToolInvoker {
  constructor(private readonly registry: ToolRegistryLike, private readonly exposure: ToolExposure) {}

  async invoke(call: LlmToolCall, ctx: ToolContext, trace?: ToolTraceSink, guard?: ToolRunGuard): Promise<ToolInvocation> {
    if (call.name === "tool_call") return this.callOnDemand(call, ctx, trace, guard);
    const definition = this.exposure.always.find((item) => item.name === call.name);
    if (!definition) {
      const onDemand = this.exposure.onDemand.some((entry) => entry.name === call.name);
      const known = this.registry.known(call.name);
      const unavailable = typeof known?.unavailable === "function" ? known.unavailable(ctx) : known?.unavailable;
      const names = this.exposure.always.map((item) => item.name);
      const text = onDemand
        ? `「${call.name}」是按需工具：先 tool_inspect 看参数，再用 tool_call 执行。`
        : unavailable ?? `未知工具 ${call.name}；只支持 ${names.join(" 与 ")}。`;
      this.emit(trace, call.id, "调用 " + call.name, "error", text.slice(0, 120), undefined, call.name);
      return { outcome: { text, ok: false } };
    }
    return this.run(definition, call, ctx, trace, guard);
  }

  private async callOnDemand(call: LlmToolCall, ctx: ToolContext, trace?: ToolTraceSink, guard?: ToolRunGuard): Promise<ToolInvocation> {
    const args = parseArgs(call.argumentsJson);
    if (!args.ok) return this.invalid(call, trace, args.reason);
    const name = stringArg(args.value, "name");
    const definition = ctx.catalog?.find(name);
    const listed = ctx.catalog?.entries.some((entry) => entry.name === name) ?? false;
    if (!definition || !listed) return this.invalid(call, trace, `没有按需工具「${name}」。`);
    const nested = (args.value as { arguments?: unknown }).arguments ?? {};
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return this.invalid(call, trace, "tool_call.arguments 必须是一个对象。");
    return this.run(definition, { ...call, name, argumentsJson: JSON.stringify(nested) }, ctx, trace, guard, `按需调用 ${name}`);
  }

  private async run(definition: ToolDefinition, call: LlmToolCall, ctx: ToolContext, trace?: ToolTraceSink, guard?: ToolRunGuard, label?: string): Promise<ToolInvocation> {
    const parsed = parseArgs(call.argumentsJson);
    if (!parsed.ok) return { outcome: this.invalid(call, trace, parsed.reason).outcome, definition };
    const invalid = validate(definition, parsed.value);
    if (invalid) return { outcome: this.invalid(call, trace, `参数不合 ${definition.name} 的 schema：${invalid}`).outcome, definition };
    const startLabel = label ?? definition.describe?.(parsed.value)?.label ?? definition.summary;
    this.emit(trace, call.id, startLabel, "start", undefined, undefined, definition.name);
    const startedAt = Date.now();
    const refused = guard?.(definition);
    if (refused) {
      this.emit(trace, call.id, startLabel, "error", refused.slice(0, 120), Date.now() - startedAt, definition.name);
      return { outcome: { text: refused, ok: false }, definition };
    }
    try {
      const raw = await definition.invoke(parsed.value, ctx);
      const outcome = sanitize(raw);
      if (outcome.stop?.reason !== "await_user") {
        this.emit(trace, call.id, startLabel, outcome.ok === false ? "error" : "ok", outcome.detail ?? (outcome.ok === false ? outcome.text.slice(0, 120) : undefined), Date.now() - startedAt, definition.name);
      }
      return { outcome, definition };
    } catch (error) {
      const text = `工具 ${definition.name} 执行失败：${error instanceof Error ? error.message : "未知错误"}`;
      this.emit(trace, call.id, startLabel, "error", text.slice(0, 120), Date.now() - startedAt, definition.name);
      return { outcome: { text, ok: false }, definition };
    }
  }

  private invalid(call: LlmToolCall, trace: ToolTraceSink | undefined, reason: string): ToolInvocation {
    this.emit(trace, call.id, `调用 ${call.name}`, "error", reason.slice(0, 120), undefined, call.name);
    return { outcome: { text: reason, ok: false } };
  }

  private emit(trace: ToolTraceSink | undefined, stepId: string, label: string, status: "start" | "ok" | "error", detail?: string, ms?: number, tool?: string): void {
    trace?.onTrace?.({ kind: "tool", status, stepId, label, ...(tool ? { tool } : {}), ...(detail ? { detail } : {}), ...(ms === undefined ? {} : { ms }), round: trace.round });
  }
}

function parseArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "工具参数必须是一个对象。" };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "工具参数不是合法 JSON。" };
  }
}

function validate(definition: ToolDefinition, args: Record<string, unknown>): string | undefined {
  const validator = compileCached(definition);
  if (!validator) {
    // 内部工具的 schema 编译不过属实现缺陷，宁可拒跑；外部 schema 形状不可控，跳过校验。
    return definition.origin.kind === "internal" ? `工具 ${definition.name} 的 schema 编译失败，这次未执行。` : undefined;
  }
  if (validator(args)) return undefined;
  const first = validator.errors?.[0];
  return first ? `${first.instancePath || "/"} ${first.message ?? "不合法"}` : "不合法";
}

function compileCached(definition: ToolDefinition): ValidateFunction | undefined {
  const key = `${definition.name}:${JSON.stringify(definition.schema)}`;
  const cached = validators.get(key);
  if (cached) return cached;
  try {
    const compiled = ajv.compile(definition.schema);
    validators.set(key, compiled);
    return compiled;
  } catch (error) {
    traceEngine("degrade", { what: "tool_schema_uncompilable", tool: definition.name, origin: definition.origin.kind, reason: error instanceof Error ? error.message : "unknown" });
    return undefined;
  }
}

function sanitize(outcome: ToolOutcome): ToolOutcome {
  const masked = maskSecrets(outcome.text);
  const text = masked.text.length > RESULT_CHARS ? `${masked.text.slice(0, RESULT_CHARS)}\n…（工具结果已截断）` : masked.text;
  return {
    ...outcome,
    text,
    ...(masked.masked > 0 ? { detail: outcome.detail ?? "已隐去敏感内容" } : {})
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}
