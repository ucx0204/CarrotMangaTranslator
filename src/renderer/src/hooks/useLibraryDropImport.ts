import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  MAX_DROPPED_IMPORT_PATHS,
  type DroppedImportPreviewResponse,
  type ImportPreviewSession,
} from "../../../shared/importTypes";
import { libraryGateway } from "../api/libraryGateway";
import { resolveDroppedImportRejectionMessage } from "../lib/droppedImportFeedback";
import { formatErrorMessage } from "../lib/errorPresentation";
import { toast } from "../lib/toastStore";
import { useEventCallback } from "./useEventCallback";

type UseLibraryDropImportOptions = {
  blocked: boolean;
  pushStatus: (line: string) => void;
  setImportPreview: React.Dispatch<
    React.SetStateAction<ImportPreviewSession | null>
  >;
  setTranslationSourceOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

export type LibraryDropImportController = {
  active: boolean;
  blocked: boolean;
  busy: boolean;
};

export function useLibraryDropImport({
  blocked,
  pushStatus,
  setImportPreview,
  setTranslationSourceOpen,
}: UseLibraryDropImportOptions): LibraryDropImportController {
  const { t } = useTranslation("renderer");
  const [active, setActive] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const blockedRef = React.useRef(blocked);
  const busyRef = React.useRef(false);

  React.useLayoutEffect(() => {
    blockedRef.current = blocked;
  }, [blocked]);

  const previewDroppedFiles = useEventCallback(async (files: File[]) => {
    if (blockedRef.current || busyRef.current) {
      toast.info(t("import.drop.unavailable"));
      return;
    }
    if (files.length > MAX_DROPPED_IMPORT_PATHS) {
      showRejection({ status: "rejected", reason: "too-many-items" }, t);
      return;
    }

    busyRef.current = true;
    setBusy(true);
    try {
      const filePaths = files
        .map((file) => libraryGateway.getPathForFile(file))
        .filter((filePath) => filePath.length > 0);
      if (filePaths.length === 0) {
        showRejection({ status: "rejected", reason: "empty" }, t);
        return;
      }
      const response = await libraryGateway.previewDroppedImport(filePaths);
      if (response.status === "rejected") {
        showRejection(response, t);
        return;
      }
      if (blockedRef.current) {
        toast.info(t("import.drop.unavailable"));
        return;
      }
      setTranslationSourceOpen(false);
      setImportPreview(response.preview);
    } catch (error) {
      const message = formatErrorMessage(error, t("import.drop.readFailed"));
      pushStatus(message);
      toast.error(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  });

  useGlobalFileDrop({
    blocked: blocked || busy,
    onActiveChange: setActive,
    onDrop: previewDroppedFiles,
  });

  return { active, blocked: blocked || busy, busy };
}

function showRejection(
  rejection: Extract<DroppedImportPreviewResponse, { status: "rejected" }>,
  t: TFunction<"renderer">,
): void {
  const message = resolveDroppedImportRejectionMessage(
    rejection,
    t,
    MAX_DROPPED_IMPORT_PATHS,
  );
  if (rejection.reason === "busy") {
    toast.info(message);
  } else {
    toast.warn(message);
  }
}

function useGlobalFileDrop({
  blocked,
  onActiveChange,
  onDrop,
}: {
  blocked: boolean;
  onActiveChange: (active: boolean) => void;
  onDrop: (files: File[]) => void;
}): void {
  const dragDepthRef = React.useRef(0);
  const handleWindowEvent = useEventCallback((event: DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.type === "drop") {
      dragDepthRef.current = 0;
      onActiveChange(false);
      onDrop(Array.from(event.dataTransfer?.files ?? []));
      return;
    }
    if (event.type === "dragenter") {
      dragDepthRef.current += 1;
      onActiveChange(true);
      return;
    }
    if (event.type === "dragleave") {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        onActiveChange(false);
      }
      return;
    }
    if (event.dataTransfer) {
      onActiveChange(true);
      event.dataTransfer.dropEffect = blocked ? "none" : "copy";
    }
  });

  React.useEffect(() => {
    const eventNames = ["dragenter", "dragover", "dragleave", "drop"] as const;
    for (const eventName of eventNames) {
      window.addEventListener(eventName, handleWindowEvent, true);
    }
    return () => {
      dragDepthRef.current = 0;
      for (const eventName of eventNames) {
        window.removeEventListener(eventName, handleWindowEvent, true);
      }
    };
  }, [handleWindowEvent]);
}

function isFileDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(
    dataTransfer && Array.from(dataTransfer.types).includes("Files"),
  );
}
