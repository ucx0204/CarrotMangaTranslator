import React from "react";

type UseStatusLogResult = {
  statusLines: string[];
  appendStatusLine: (line: string, replaceExisting?: (line: string) => boolean) => void;
  pushStatus: (line: string) => void;
  clearStatusLines: () => void;
};

export function useStatusLog(): UseStatusLogResult {
  const [statusLines, setStatusLines] = React.useState<string[]>([]);

  const appendStatusLine = React.useCallback((line: string, replaceExisting?: (line: string) => boolean) => {
    const next = line.trim();
    if (!next) {
      return;
    }
    setStatusLines((lines) => {
      if (lines[0] === next) {
        return lines;
      }
      const remaining = replaceExisting ? lines.filter((line) => !replaceExisting(line)) : lines;
      return [next, ...remaining].slice(0, 16);
    });
  }, []);

  const pushStatus = React.useCallback(
    (line: string) => {
      void window.mangaApi.writeLog("info", "UI status", { line });
      appendStatusLine(line);
    },
    [appendStatusLine]
  );

  const clearStatusLines = React.useCallback(() => {
    setStatusLines([]);
  }, []);

  return { statusLines, appendStatusLine, pushStatus, clearStatusLines };
}
