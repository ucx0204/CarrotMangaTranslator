import { mcpContextRevision } from "../../shared/mcpContextEditing";
import {
  readChapterStoryMemory,
  resolveWorkContextForChapter,
} from "../libraryStore/workContextFiles";

/** Called under the existing library lock; never recursively acquires a facade lock. */
export async function retainedContextRevision(chapterId: string) {
  const context = await resolveWorkContextForChapter(chapterId);
  return mcpContextRevision({
    ...context,
    storyMemory: await readChapterStoryMemory(chapterId),
  });
}
