import React from "react";
import { useTranslation } from "react-i18next";
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
  const { i18n } = useTranslation();
  const [statusLines, setStatusLines] = React.useState<string[]>([]);

  React.useEffect(() => {
    const clearTranslatedHistory = () => setStatusLines([]);
    i18n.on("languageChanged", clearTranslatedHistory);
    return () => {
      i18n.off("languageChanged", clearTranslatedHistory);
    };
  }, [i18n]);

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
