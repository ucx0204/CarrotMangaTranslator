import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readMcpCompositeFontEnvironment } from "../src/main/mcp/mcpCompositeNativeFonts";
import { failAfterCompositeNativeCleanup } from "../src/main/mcp/mcpCompositeNativeCleanup";

it("hashes actual native bundled weight faces and detects same-size same-mtime replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-composite-fonts-"));
  const fontRoot = join(root, "src/renderer/src/assets/fonts");
  await mkdir(fontRoot, { recursive: true });
  try {
    const regular = join(fontRoot, "regular.ttf");
    const bold = join(fontRoot, "bold.ttf");
    await writeFile(regular, Buffer.from("regular-face"));
    await writeFile(bold, Buffer.from("bold-face-01"));
    const paths = {
      repoRoot: root,
      isPackaged: false,
      fontsDir: join(root, "custom"),
    };
    const read = () =>
      readMcpCompositeFontEnvironment(
        () => {},
        paths,
        (name) => join(fontRoot, name),
      );
    const before = await read();
    const stamp = await stat(bold);
    await writeFile(bold, Buffer.from("bold-face-02"));
    await utimes(bold, stamp.atime, stamp.mtime);
    expect(await read()).not.toBe(before);
    await mkdir(paths.fontsDir);
    const id = randomUUID();
    const custom = join(paths.fontsDir, `${id}.ttf`);
    await writeFile(custom, Buffer.from("custom-face-1"));
    await writeFile(
      join(paths.fontsDir, "index.json"),
      JSON.stringify([
        {
          id,
          family: `MGTUser-${id}`,
          fileName: `${id}.ttf`,
          label: "Owned custom fixture",
        },
      ]),
    );
    const registered = await read();
    const customStamp = await stat(custom);
    await writeFile(custom, Buffer.from("custom-face-2"));
    await utimes(custom, customStamp.atime, customStamp.mtime);
    expect(await read()).not.toBe(registered);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a native face above the unchanged 32 MiB bound before hashing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-composite-font-cap-"));
  const fonts = join(root, "src/renderer/src/assets/fonts");
  await mkdir(fonts, { recursive: true });
  try {
    const path = join(fonts, "large.ttf");
    await writeFile(path, "");
    await truncate(path, 32 * 1024 * 1024 + 1);
    await expect(
      readMcpCompositeFontEnvironment(
        () => {},
        { repoRoot: root, isPackaged: false, fontsDir: join(root, "custom") },
        () => path,
      ),
    ).rejects.toMatchObject({ code: "invalid_edit" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves the original authority error together with physical cleanup failure", async () => {
  const original = new Error("authority revoked");
  const cleanup = new Error("font handle close failed");
  let caught: unknown;
  try {
    await failAfterCompositeNativeCleanup(original, async () => {
      throw cleanup;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect(caught).toMatchObject({ cause: cleanup, errors: [original, cleanup] });
  await expect(
    failAfterCompositeNativeCleanup(original, async () => {}),
  ).rejects.toBe(original);
});
