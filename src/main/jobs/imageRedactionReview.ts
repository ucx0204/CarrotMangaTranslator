import { randomUUID } from "node:crypto";
import type { MangaPage } from "../../shared/libraryTypes";
import type { JobEvent } from "../../shared/jobTypes";
import {
  confirmImageRedactionSchema,
  type ConfirmImageRedaction,
  type ImageRedactionPage,
} from "../../shared/imageRedaction";
import {
  readImageRedactionState,
  saveImageRedactionPages,
} from "../imageRedactionStore";
import {
  imageFingerprint,
  withApprovedImageRedactions,
} from "../imageRedactionContext";
import { getAppSettings } from "../settingsStore";
import { prepareImageRedactionPages } from "../imageRedactionPagePreparation";
import {
  openRedactionWorkspaceSession,
  assertRedactionWorkspaceConfirmation,
  closeRedactionWorkspace,
} from "../imageRedactionWorkspaceSessions";

type Pending = {
  sessionId: string;
  pages: ImageRedactionPage[];
  signal: AbortSignal;
  resolve: (pages: ImageRedactionPage[]) => void;
  save: typeof saveImageRedactionPages;
  confirming?: boolean;
};
const pending = new Map<string, Pending>();
const productionStore = {
  read: readImageRedactionState,
  save: saveImageRedactionPages,
  settings: getAppSettings,
};
type ReviewInput = {
  jobId: string;
  kind: JobEvent["kind"];
  pages: MangaPage[];
  signal: AbortSignal;
  emit: (event: JobEvent) => void;
  imageEdit?: boolean;
};

export async function withImageRedactionReview<T>(
  input: ReviewInput,
  run: () => Promise<T>,
  store = productionStore,
): Promise<T> {
  input.signal.throwIfAborted();
  const settings = await store.read();
  if (
    !settings.enabled ||
    (!input.imageEdit && (await store.settings()).modelProvider === "gemma")
  )
    return run();
  const pages = await prepareImageRedactionPages(
    input.pages,
    settings.pages,
    input.signal,
  );
  const sessionId = randomUUID();
  let cancel = () => {};
  try {
    const approved = await new Promise<ImageRedactionPage[]>(
      (resolve, reject) => {
        input.signal.throwIfAborted();
        cancel = () =>
          reject(
            input.signal.reason ?? new Error("이미지 전송을 취소했습니다."),
          );
        pending.set(input.jobId, {
          sessionId,
          pages,
          signal: input.signal,
          resolve,
          save: store.save,
        });
        input.signal.addEventListener("abort", cancel, { once: true });
        input.emit({
          id: input.jobId,
          kind: input.kind,
          status: "running",
          phase: "model_requesting",
          progressText: "전송 이미지 확인",
          imageRedactionReview: { sessionId, pages },
        });
      },
    );
    input.signal.throwIfAborted();
    return await withApprovedImageRedactions(approved, run, input.signal);
  } finally {
    pending.delete(input.jobId);
    input.signal.removeEventListener("abort", cancel);
    await closeRedactionWorkspace(sessionId);
  }
}

export async function openPendingRedactionWorkspace(
  jobId: string,
  sessionId: string,
  root: string,
) {
  const entry = pending.get(jobId);
  if (!entry || entry.sessionId !== sessionId || entry.confirming)
    throw new Error("이미지 확인이 만료되었거나 이미 저장 중입니다.");
  entry.signal.throwIfAborted();
  const workspace = await openRedactionWorkspaceSession(
    entry.pages,
    sessionId,
    root,
  );
  entry.signal.throwIfAborted();
  return workspace;
}

export async function confirmImageRedaction(
  input: ConfirmImageRedaction,
): Promise<boolean> {
  const request = confirmImageRedactionSchema.parse(input);
  const entry = pending.get(request.jobId);
  if (!entry || entry.sessionId !== request.sessionId)
    throw new Error("이미지 확인이 만료되었습니다.");
  if (entry.confirming) throw new Error("이미지 확인을 저장하고 있습니다.");
  entry.confirming = true;
  try {
    await assertRedactionWorkspaceConfirmation(request);
    return await saveConfirmedRedactions(request, entry);
  } finally {
    entry.confirming = false;
  }
}

async function saveConfirmedRedactions(
  request: ConfirmImageRedaction,
  entry: Pending,
): Promise<boolean> {
  entry.signal.throwIfAborted();
  const patches = new Map(request.pages.map((page) => [page.id, page]));
  if (
    patches.size !== request.pages.length ||
    patches.size !== entry.pages.length
  )
    throw new Error("확인할 페이지 목록이 다릅니다.");
  const pages: ImageRedactionPage[] = [];
  for (let offset = 0; offset < entry.pages.length; offset += 4) {
    entry.signal.throwIfAborted();
    const chunk = await Promise.all(
      entry.pages.slice(offset, offset + 4).map(async (page) => {
        const patch = patches.get(page.id);
        if (
          !patch ||
          patch.fingerprint !== page.fingerprint ||
          (await imageFingerprint(page.imagePath)) !== page.fingerprint
        )
          throw new Error("확인한 원본 이미지가 변경되었습니다.");
        return { ...page, strokes: patch.strokes };
      }),
    );
    pages.push(...chunk);
  }
  entry.signal.throwIfAborted();
  await entry.save(pages);
  entry.signal.throwIfAborted();
  entry.resolve(pages);
  pending.delete(request.jobId);
  return true;
}
