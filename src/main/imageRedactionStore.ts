import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAppPaths } from "./appPaths";
import {
  imageRedactionStrokeSchema,
  type ImageRedactionPage,
} from "../shared/imageRedaction";

const schema = z.object({
  enabled: z.boolean(),
  pages: z.record(
    z.object({
      fingerprint: z.string(),
      strokes: z.array(imageRedactionStrokeSchema),
    }),
  ),
});
type State = z.infer<typeof schema>;
let queue: Promise<unknown> = Promise.resolve();
export async function readImageRedactionState(
  root = getAppPaths().dataRoot,
): Promise<State> {
  try {
    return schema.parse(
      JSON.parse(await readFile(join(root, "image-redactions.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { enabled: false, pages: {} };
    throw error;
  }
}
function update(
  change: (state: State) => void,
  root = getAppPaths().dataRoot,
): Promise<void> {
  const run = queue.then(async () => {
    const state = await readImageRedactionState(root);
    change(state);
    await mkdir(root, { recursive: true });
    const temporary = join(root, `image-redactions-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(state), "utf8");
      await rename(temporary, join(root, "image-redactions.json"));
    } finally {
      await rm(temporary, { force: true }).catch((error: unknown) =>
        console.error("Redaction temporary cleanup failed", error),
      );
    }
  });
  queue = run.catch((error: unknown) =>
    console.error("Image redaction save failed", error),
  );
  return run;
}
export function setImageRedactionEnabled(
  enabled: boolean,
  root?: string,
): Promise<void> {
  return update((state) => {
    state.enabled = enabled;
  }, root);
}
export function saveImageRedactionPages(
  pages: readonly ImageRedactionPage[],
  root?: string,
): Promise<void> {
  return update((state) => {
    for (const page of pages)
      state.pages[page.imagePath] = {
        fingerprint: page.fingerprint,
        strokes: page.strokes,
      };
  }, root);
}
