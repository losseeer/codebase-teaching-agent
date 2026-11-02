import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { TraceRun } from "./useAgentTrace";

/** 历史回放：journal 汇总的最近回合；弹窗打开时取一次。 */
export function useTraceHistory(repositoryId: string | null, limit = 20): { runs: TraceRun[]; error: string | null; loading: boolean } {
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
    void api.getTraceHistory(repositoryId, limit)
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
  }, [repositoryId, limit]);
  return { runs, error, loading };
}
