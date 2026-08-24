import React from "react";
import { appGateway as mangaGateway } from "../api/appGateway";
type UseStatusLogResult = {
  statusLines: string[];
  appendStatusLine: (
    line: string,
    replaceExisting?: (line: string) => boolean,
  ) => void;
  pushStatus: (line: string) => void;
  clearStatusLines: () => void;
};

export function useStatusLog(): UseStatusLogResult {
  const [statusLines, setStatusLines] = React.useState<string[]>([]);

  /*
   * Lines already written stay as they are after a language switch. They are a
   * record of what happened, and re-translating them is impossible once the
   * arguments are gone — dropping the history to keep the panel monolingual
   * would throw away the only account of a failure the user is investigating.
   */

  const appendStatusLine = React.useCallback(
    (line: string, replaceExisting?: (line: string) => boolean) => {
      const next = line.trim();
      if (!next) {
        return;
      }
      setStatusLines((lines) => {
        if (lines[0] === next) {
          return lines;
        }
        const remaining = replaceExisting
          ? lines.filter((line) => !replaceExisting(line))
          : lines;
        return [next, ...remaining].slice(0, 16);
      });
    },
    [],
  );

  const pushStatus = React.useCallback(
    (line: string) => {
      void mangaGateway
        .writeLog("info", "UI status", { line })
        .catch((error) => console.warn(error));
      appendStatusLine(line);
    },
    [appendStatusLine],
  );

  const clearStatusLines = React.useCallback(() => {
    setStatusLines([]);
  }, []);

  return { statusLines, appendStatusLine, pushStatus, clearStatusLines };
}
