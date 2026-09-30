import type { CostSummary, JournalEvent } from "@codebase-tutor/shared";
import { readJournal } from "../store/journal.js";

export const defaultMonthlyBudgetUsd = 5;
const inputRatePerMillion = Number(process.env.TUTOR_INPUT_USD_PER_MILLION ?? 0);
const outputRatePerMillion = Number(process.env.TUTOR_OUTPUT_USD_PER_MILLION ?? 0);

export function summarizeCost(repositoryPath: string, monthlyBudgetUsd = defaultMonthlyBudgetUsd, sessionId?: string): CostSummary {
  const month = new Date().toISOString().slice(0, 7);
  const events = readJournal(repositoryPath).filter((event) => event.type === "token_usage" && event.at.startsWith(month) && (!sessionId || event.sessionId === sessionId));
  const inputTokens = sum(events, "input_tokens");
  const outputTokens = sum(events, "output_tokens");
  const estimatedCostUsd = inputTokens * inputRatePerMillion / 1_000_000 + outputTokens * outputRatePerMillion / 1_000_000;
  const remainingBudgetUsd = Math.max(0, monthlyBudgetUsd - estimatedCostUsd);
  return { sessionId, inputTokens, outputTokens, estimatedCostUsd, monthlyBudgetUsd, remainingBudgetUsd, mode: estimatedCostUsd >= monthlyBudgetUsd ? "degraded" : "normal" };
}

function sum(events: JournalEvent[], key: string): number {
  return events.reduce((total, event) => total + (typeof event.payload[key] === "number" ? event.payload[key] as number : 0), 0);
}
