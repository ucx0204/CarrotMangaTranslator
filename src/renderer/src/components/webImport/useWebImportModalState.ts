import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImportPreviewSession } from "../../../../shared/importTypes";
import type {
  WebImportProgressEvent,
  WebImportScanResult,
  WebImportSizeFilter,
} from "../../../../shared/webImportTypes";
import { libraryGateway } from "../../api/libraryGateway";
import { formatErrorMessage } from "../../lib/errorPresentation";
import {
  filterWebImportCandidates,
  setVisibleWebImportSelection,
} from "../../lib/webImportSelection";

export function useWebImportModalState({
  onCancel,
  onPrepared,
}: {
  onCancel: () => void;
  onPrepared: (preview: ImportPreviewSession) => void;
}) {
  const { t } = useTranslation("components");
  const [url, setUrl] = useState("");
  const [filter, setFilter] = useState<WebImportSizeFilter>("large");
  const [result, setResult] = useState<WebImportScanResult | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [progress, setProgress] = useState<WebImportProgressEvent | null>(null);
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const requestRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const visibleCandidates = useMemo(
    () => filterWebImportCandidates(result?.candidates ?? [], filter),
    [filter, result],
  );
  const selectedCandidates = useMemo(
    () => visibleCandidates.filter((candidate) => !excluded.has(candidate.id)),
    [excluded, visibleCandidates],
  );

  useProgressSubscription(requestRef, mountedRef, setProgress);
  useUnmountCancellation(requestRef, mountedRef);
  useSessionDisposal(result);
  const scan = useWebImportScanAction({
    mountedRef,
    requestRef,
    setError,
    setExcluded,
    setFilter,
    setProgress,
    setResult,
    setScanning,
    setUrl,
    t,
    url,
  });
  const cancel = useWebImportCancelAction(requestRef, onCancel);
  const prepare = useWebImportPrepareAction({
    onPrepared,
    result,
    selectedCandidateIds: selectedCandidates.map((item) => item.id),
    setError,
    setPreparing,
    t,
  });
  const setCandidateSelected = useCandidateSelectionAction(setExcluded);
  const setVisibleSelected = useVisibleSelectionAction(
    setExcluded,
    visibleCandidates.map((candidate) => candidate.id),
  );

  return {
    busy: scanning || preparing,
    cancel,
    error,
    excluded,
    filter,
    prepare,
    preparing,
    progress,
    result,
    scan,
    scanning,
    selectedCount: selectedCandidates.length,
    setCandidateSelected,
    setFilter,
    setUrl,
    setVisibleSelected,
    url,
    visibleCandidates,
  };
}

type WebImportStateSetter<T> = React.Dispatch<React.SetStateAction<T>>;

function useWebImportScanAction({
  mountedRef,
  requestRef,
  setError,
  setExcluded,
  setFilter,
  setProgress,
  setResult,
  setScanning,
  setUrl,
  t,
  url,
}: {
  mountedRef: React.RefObject<boolean>;
  requestRef: React.RefObject<string | null>;
  setError: WebImportStateSetter<string>;
  setExcluded: WebImportStateSetter<Set<string>>;
  setFilter: WebImportStateSetter<WebImportSizeFilter>;
  setProgress: WebImportStateSetter<WebImportProgressEvent | null>;
  setResult: WebImportStateSetter<WebImportScanResult | null>;
  setScanning: WebImportStateSetter<boolean>;
  setUrl: WebImportStateSetter<string>;
  t: ReturnType<typeof useTranslation<"components">>["t"];
  url: string;
}): () => Promise<void> {
  return useCallback(async () => {
    const normalized = normalizePublicUrlInput(url);
    if (!normalized) {
      setError(t("webImport.errors.invalidUrl"));
      return;
    }
    startWebImportScanState({
      normalized,
      setError,
      setExcluded,
      setProgress,
      setResult,
      setScanning,
      setUrl,
    });
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    try {
      const response = await libraryGateway.scanWebImport({
        requestId,
        url: normalized,
      });
      if (!mountedRef.current || requestRef.current !== requestId) return;
      if (response.status === "rejected") {
        setError(t(`webImport.errors.${response.reason}`));
      } else {
        setResult(response.result);
        setFilter("large");
        setExcluded(new Set());
      }
    } catch (caught) {
      if (mountedRef.current) {
        setError(formatErrorMessage(caught, t("webImport.errors.scanFailed")));
      }
    } finally {
      if (mountedRef.current && requestRef.current === requestId) {
        requestRef.current = null;
        setScanning(false);
      }
    }
  }, [
    mountedRef,
    requestRef,
    setError,
    setExcluded,
    setFilter,
    setProgress,
    setResult,
    setScanning,
    setUrl,
    t,
    url,
  ]);
}

function startWebImportScanState({
  normalized,
  setError,
  setExcluded,
  setProgress,
  setResult,
  setScanning,
  setUrl,
}: {
  normalized: string;
  setError: WebImportStateSetter<string>;
  setExcluded: WebImportStateSetter<Set<string>>;
  setProgress: WebImportStateSetter<WebImportProgressEvent | null>;
  setResult: WebImportStateSetter<WebImportScanResult | null>;
  setScanning: WebImportStateSetter<boolean>;
  setUrl: WebImportStateSetter<string>;
}): void {
  setUrl(normalized);
  setError("");
  setProgress(null);
  setExcluded(new Set());
  setResult(null);
  setScanning(true);
}

function useWebImportCancelAction(
  requestRef: React.RefObject<string | null>,
  onCancel: () => void,
): () => void {
  return useCallback(() => {
    cancelActiveWebImportScan(requestRef);
    onCancel();
  }, [onCancel, requestRef]);
}

function useWebImportPrepareAction({
  onPrepared,
  result,
  selectedCandidateIds,
  setError,
  setPreparing,
  t,
}: {
  onPrepared: (preview: ImportPreviewSession) => void;
  result: WebImportScanResult | null;
  selectedCandidateIds: string[];
  setError: WebImportStateSetter<string>;
  setPreparing: WebImportStateSetter<boolean>;
  t: ReturnType<typeof useTranslation<"components">>["t"];
}): () => Promise<void> {
  return useCallback(async () => {
    if (!result || selectedCandidateIds.length === 0) return;
    setPreparing(true);
    setError("");
    try {
      onPrepared(
        await libraryGateway.prepareWebImport({
          sessionId: result.sessionId,
          selectedCandidateIds,
        }),
      );
    } catch (caught) {
      setError(formatErrorMessage(caught, t("webImport.errors.prepareFailed")));
      setPreparing(false);
    }
  }, [onPrepared, result, selectedCandidateIds, setError, setPreparing, t]);
}

function useCandidateSelectionAction(
  setExcluded: WebImportStateSetter<Set<string>>,
): (id: string, selected: boolean) => void {
  return useCallback(
    (id, selected) => {
      setExcluded((current) => {
        const next = new Set(current);
        if (selected) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [setExcluded],
  );
}

function useVisibleSelectionAction(
  setExcluded: WebImportStateSetter<Set<string>>,
  visibleCandidateIds: string[],
): (selected: boolean) => void {
  return useCallback(
    (selected) =>
      setExcluded((current) =>
        setVisibleWebImportSelection(current, visibleCandidateIds, selected),
      ),
    [setExcluded, visibleCandidateIds],
  );
}

function useProgressSubscription(
  requestRef: React.RefObject<string | null>,
  mountedRef: React.RefObject<boolean>,
  setProgress: React.Dispatch<
    React.SetStateAction<WebImportProgressEvent | null>
  >,
): void {
  useEffect(
    () =>
      libraryGateway.onWebImportProgress((event) => {
        if (event.requestId === requestRef.current && mountedRef.current) {
          setProgress(event);
        }
      }),
    [mountedRef, requestRef, setProgress],
  );
}

function useUnmountCancellation(
  requestRef: React.RefObject<string | null>,
  mountedRef: React.RefObject<boolean>,
): void {
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelActiveWebImportScan(requestRef);
    };
  }, [mountedRef, requestRef]);
}

function cancelActiveWebImportScan(
  requestRef: React.RefObject<string | null>,
): void {
  const requestId = requestRef.current;
  if (!requestId) return;
  void libraryGateway.cancelWebImportScan(requestId).catch((_error) => {
    // error-policy-allow: unmount cancellation is best-effort during teardown.
  });
}

function useSessionDisposal(result: WebImportScanResult | null): void {
  useEffect(() => {
    if (!result) return;
    const sessionId = result.sessionId;
    return () => {
      void libraryGateway.discardWebImportSession(sessionId).catch((_error) => {
        // error-policy-allow: expiry and app shutdown provide fallback cleanup.
      });
    };
  }, [result]);
}

function normalizePublicUrlInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return null;
    }
    return url.href;
  } catch (_error) {
    return null;
  }
}
