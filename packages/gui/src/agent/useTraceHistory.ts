import { useEffect, useState } from "react";
import type { AgentScope } from "@codebase-tutor/contract";

import { api } from "../api/client";
import type { TraceRun } from "./useAgentTrace";

/** 历史回放：按当前会话（threadId）或工作区取 journal 汇总的最近回合；弹窗打开时读一次。 */
export function useTraceHistory(repositoryId: string | null, scope: AgentScope, limit = 20, threadId?: string | null): { runs: TraceRun[]; error: string | null; loading: boolean } {
  const [runs, setRuns] = useState<TraceRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(repositoryId));
  useEffect(() => {
    if (!repositoryId) {
      setRuns([]);
      setError(null);
      setLoading(false);
      return;
    }
    let live = true;
    setRuns([]);
    setLoading(true);
    setError(null);
    void api.getTraceHistory(repositoryId, scope, limit, threadId)
      .then((history) => {
        if (!live) return;
        setRuns(history.runs.map((run) => ({ ...run, historical: true })));
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!live) return;
        setRuns([]);
        setError(reason instanceof Error ? reason.message : "读取历史失败");
        setLoading(false);
      });
    return () => { live = false; };
  }, [repositoryId, scope, limit, threadId]);
  return { runs, error, loading };
}
