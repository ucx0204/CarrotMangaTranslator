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

export async function withImageRedactionReview<T>(
  input: {
    jobId: string;
    kind: JobEvent["kind"];
    pages: MangaPage[];
    signal: AbortSignal;
    emit: (event: JobEvent) => void;
    imageEdit?: boolean;
  },
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
  input.signal.throwIfAborted();
  const pages = await Promise.all(
    input.pages.map(async (page): Promise<ImageRedactionPage> => {
      const fingerprint = await imageFingerprint(page.imagePath);
      const saved = settings.pages[page.imagePath];
      return {
        id: page.id,
        name: page.name,
        imagePath: page.imagePath,
        width: page.width,
        height: page.height,
        fingerprint,
        strokes: saved?.fingerprint === fingerprint ? saved.strokes : [],
      };
    }),
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
  }
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
  const pages = await Promise.all(
    entry.pages.map(async (page) => {
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
  entry.signal.throwIfAborted();
  await entry.save(pages);
  entry.signal.throwIfAborted();
  entry.resolve(pages);
  pending.delete(request.jobId);
  return true;
}
