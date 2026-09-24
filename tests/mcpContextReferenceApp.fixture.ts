import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";

type NativeFixture = Awaited<ReturnType<typeof typographyAnalysisAppFixture>>;

async function createWorkFiles(f: NativeFixture) {
  const workPath = join(f.env.libraryDir, "works", "work", "work.json");
  const first: typeof f.chapter = JSON.parse(
    await readFile(f.chapterPath, "utf8"),
  );
  const second = { ...structuredClone(first), id: "chapter-two" };
  first.pages[0].blocks[0].speakerId = "character";
  second.pages[0].blocks[0].speakerId = "missing-character";
  const directory = join(
    f.env.libraryDir,
    "works",
    "work",
    "chapters",
    "chapter-two",
  );
  await mkdir(join(directory, "pages"), { recursive: true });
  for (const page of second.pages) {
    page.imagePath = join(directory, "pages", `${page.id}.png`);
    await writeFile(page.imagePath, f.bytes);
  }
  const secondPath = join(directory, "chapter.json");
  await writeFile(f.chapterPath, JSON.stringify(first));
  await writeFile(secondPath, JSON.stringify(second));
  const work = JSON.parse(await readFile(workPath, "utf8"));
  await writeFile(
    workPath,
    JSON.stringify({ ...work, chapterOrder: ["chapter", "chapter-two"] }),
  );
  return { workPath, secondPath };
}

async function saveReferenceContext(f: NativeFixture) {
  const guide = await f.library.getWorkStyleGuide("work");
  guide.characters = [
    {
      id: "character",
      displayName: "Private character",
      sourceNames: [],
      targetName: "Private character",
      speechStyle: "neutral",
      enabled: true,
      origin: "manual",
      createdAt: "initial",
      updatedAt: "initial",
    },
  ];
  await f.library.saveWorkStyleGuide(guide);
  const memory = await f.library.getChapterStoryMemory("chapter-two");
  memory.pages = [
    {
      pageId: "orphan",
      pageName: "Private name",
      pageIndex: 9,
      summary: "Private story",
      sourceDigest: "",
      translatedDigest: "",
      characterIds: ["character"],
      updatedAt: "initial",
    },
  ];
  await f.library.saveChapterStoryMemory(memory);
}

export async function contextReferenceAppFixture() {
  const f = await typographyAnalysisAppFixture();
  try {
    const paths = await createWorkFiles(f);
    await saveReferenceContext(f);
    const { createMcpContextReferenceTools } =
      await import("../src/main/mcp/mcpContextReferenceTools");
    const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
    const { mcpContextReferenceOutputs } =
      await import("../src/shared/mcpContextReferences");
    const tools = createMcpContextReferenceTools();
    const tool = tools[0];
    const context = {
      principalId: "reference-reader",
      assertAuthorized: vi.fn(),
      assertScopes: vi.fn(),
    };
    const invoke = async (
      args: Record<string, unknown> = { chapterId: "chapter" },
    ) => {
      const result = mcpToolResult(tool, await tool.invoke(args, context));
      expect(result.isError, JSON.stringify(result.structuredContent)).toBe(
        false,
      );
      return mcpContextReferenceOutputs.carrot_get_context_references.parse(
        result.structuredContent,
      );
    };
    return { ...f, ...paths, tools, tool, context, invoke };
  } catch (error) {
    await f.close();
    throw error;
  }
}
