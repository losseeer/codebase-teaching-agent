import { createContext, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import type { PracticeOperation } from "@codebase-tutor/contract";

/** 练习页当前在走哪条模型链路；能力清单按它取工具面。 */
const PracticeOperationContext = createContext<{ operation: PracticeOperation; setOperation: (operation: PracticeOperation) => void }>({
  operation: "generate",
  setOperation: () => undefined
});

export function PracticeOperationProvider({ children }: { children: ReactNode }): ReactElement {
  const [operation, setOperation] = useState<PracticeOperation>("generate");
  const value = useMemo(() => ({ operation, setOperation }), [operation]);
  return <PracticeOperationContext.Provider value={value}>{children}</PracticeOperationContext.Provider>;
}

export function usePracticeOperation(): PracticeOperation {
  return useContext(PracticeOperationContext).operation;
}

export function useSetPracticeOperation(operation: PracticeOperation): void {
  const setOperation = useContext(PracticeOperationContext).setOperation;
  useEffect(() => { setOperation(operation); }, [operation, setOperation]);
}
