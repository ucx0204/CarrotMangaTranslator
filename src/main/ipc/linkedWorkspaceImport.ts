import type {
  CreateImportRequest,
  CreateImportResult,
} from "../../shared/importTypes";
import type { IpcContext } from "./context";

export async function connectImportedChapters(
  context: IpcContext,
  command: CreateImportRequest,
  result: CreateImportResult,
): Promise<
  Pick<
    CreateImportResult,
    "linkedWorkspaceConnectedChapterIds" | "linkedWorkspaceWarning"
  >
> {
  const options = command.linkedWorkspace;
  if (!options?.enabled) return {};
  const service = context.linkedWorkspaceSync;
  if (!service) {
    return {
      linkedWorkspaceWarning: "실시간 결과 폴더 서비스를 시작하지 못했습니다.",
    };
  }
  const connected: string[] = [];
  try {
    for (const chapterId of result.chapterIds) {
      await service.connect({
        workId: result.workId,
        chapterId,
        destinationKind: "managed",
        output: {
          format: options.outputFormat,
          jpegQuality: options.jpegQuality,
          webpQuality: options.webpQuality,
          preserveSourceNames: true,
          destinationMode: "fixed",
          collisionPolicy: "replace",
        },
        enqueueExistingPages: false,
      });
      connected.push(chapterId);
    }
    return { linkedWorkspaceConnectedChapterIds: connected };
  } catch (error) {
    return {
      ...(connected.length > 0
        ? { linkedWorkspaceConnectedChapterIds: connected }
        : {}),
      linkedWorkspaceWarning:
        error instanceof Error ? error.message : String(error),
    };
  }
}
