import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImage } from "../src/main/pipeline/codexTypesettingImageRequest";
import { makePngImage } from "./helpers/imageFixtures";

vi.mock("electron", () => ({ nativeImage: {} }));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it.each([false, true])(
  "reads %s absolute generated assets from the client workspace, saving evidence separately",
  async (absolute) => {
    const root = await mkdtemp(join(tmpdir(), "image-path-"));
    roots.push(root);
    const scratch = join(root, "scratch"),
      artifacts = join(root, "artifacts");
    await mkdir(scratch);
    await mkdir(artifacts);
    const bytes = makePngImage(8, 6);
    const imagePath = join(scratch, "result.png");
    await writeFile(imagePath, bytes);
    const client = {
      runEphemeralTurn: vi.fn(async () => ({
        threadId: "thread",
        turnId: "turn",
        itemId: "turn",
        imageDirectory: scratch,
        text: JSON.stringify({
          savedPath: absolute ? imagePath : "result.png",
        }),
      })),
    };
    const result = await generateImage(
      client,
      artifacts,
      new AbortController().signal,
      "Translate supplied lettering.",
      [],
      { width: 100, height: 140 },
    );
    expect(result).toEqual(bytes);
    expect(await readFile(join(artifacts, "image-output-turn.png"))).toEqual(
      bytes,
    );
    expect(client.runEphemeralTurn).toHaveBeenCalledOnce();
    const accounting = JSON.parse(
      await readFile(join(artifacts, "image-call-turn.json"), "utf8"),
    );
    expect(accounting.nativeSize).toEqual({ width: 100, height: 140 });
    expect(accounting.targetSize).toEqual({ width: 110, height: 154 });
    expect(accounting.prompt).toContain("1.1x each edge");
  },
);

it.each(["traversal", "junction"])(
  "rejects %s escapes from generated assets",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "image-escape-"));
    roots.push(root);
    const scratch = join(root, "scratch"),
      outside = join(root, "outside");
    await mkdir(scratch);
    await mkdir(outside);
    await writeFile(join(outside, "result.png"), makePngImage(1, 1));
    if (kind === "junction")
      await symlink(outside, join(scratch, "linked"), "junction");
    const client = {
      runEphemeralTurn: async () => ({
        threadId: "t",
        turnId: "t",
        itemId: "t",
        imageDirectory: scratch,
        text: JSON.stringify({
          savedPath:
            kind === "junction" ? "linked/result.png" : "../outside/result.png",
        }),
      }),
    };
    await expect(
      generateImage(client, root, new AbortController().signal, "edit", [], {
        width: 1,
        height: 1,
      }),
    ).rejects.toThrow("작업 폴더 밖");
    expect(await readFile(join(outside, "result.png"))).toEqual(
      makePngImage(1, 1),
    );
    if (kind === "junction") await rm(join(scratch, "linked"));
  },
);
