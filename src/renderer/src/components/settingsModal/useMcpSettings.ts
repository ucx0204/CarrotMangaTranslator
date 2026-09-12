import { useCallback, useEffect, useRef, useState } from "react";
import type {
  McpDesktopStatus,
  McpDiagnostics,
} from "../../../../shared/mcpDesktopTypes";
import { mcpGateway } from "../../api/mcpGateway";

export function useMcpSettings() {
  const [status, setStatus] = useState<McpDesktopStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<McpDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const sequence = useRef(0);
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const stamp = sequence.current;
      try {
        const next = await mcpGateway.getMcpStatus();
        if (alive.current && stamp === sequence.current) setStatus(next);
      } catch (failure) {
        if (alive.current)
          setError(
            failure instanceof Error ? failure.message : "MCP 상태 조회 실패",
          );
      }
      if (alive.current) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, []);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    const stamp = ++sequence.current;
    setBusy(true);
    setError(null);
    try {
      await action();
      const next = await mcpGateway.getMcpStatus();
      if (alive.current && stamp === sequence.current) setStatus(next);
    } catch (failure) {
      if (alive.current && stamp === sequence.current)
        setError(failure instanceof Error ? failure.message : "MCP 작업 실패");
    } finally {
      if (alive.current && stamp === sequence.current) {
        setBusy(false);
      }
    }
  }, []);
  return {
    status,
    error,
    busy,
    diagnostics,
    run,
    diagnose: () =>
      run(async () => {
        const result = await mcpGateway.diagnoseMcp();
        if (alive.current) setDiagnostics(result);
      }),
  };
}
