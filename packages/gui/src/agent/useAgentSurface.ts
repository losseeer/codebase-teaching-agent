import { useEffect, useState } from "react";
import type { AgentScope, AgentSurface, PracticeOperation } from "@codebase-tutor/contract";

import { api } from "../api/client";

/** 只读能力面：技能与工具清单；弹窗打开或当前操作变化时取一次。 */
export function useAgentSurface(repositoryId: string | null, scope: AgentScope, operation?: PracticeOperation): { surface: AgentSurface | null; error: string | null; loading: boolean } {
  const [surface, setSurface] = useState<AgentSurface | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(repositoryId));
  useEffect(() => {
    if (!repositoryId) {
      setSurface(null);
      setError(null);
      setLoading(false);
      return;
    }
    let live = true;
    setSurface(null);
    setLoading(true);
    setError(null);
    void api.getAgentSurface(repositoryId, scope, operation)
      .then((value) => { if (live) { setSurface(value); setLoading(false); } })
      .catch((reason: unknown) => {
        if (!live) return;
        setSurface(null);
        setError(reason instanceof Error ? reason.message : "读取能力清单失败");
        setLoading(false);
      });
    return () => { live = false; };
  }, [repositoryId, scope, operation]);
  return { surface, error, loading };
}
