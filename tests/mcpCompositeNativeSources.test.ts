import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { compositeNativeSourcesFixture } from "./mcpCompositeNativeSources.fixture";

it("binds actual original bytes even when file size, mtime and page metadata are unchanged", async () => {
  const f = await compositeNativeSourcesFixture();
  try {
    const before = await f.read();
    const path = before.values[0].page.imagePath;
    const stamp = await stat(path);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(path, bytes);
    await utimes(path, stamp.atime, stamp.mtime);
    const after = await f.read();
    expect(after.snapshot.pages[0].revision).toBe(
      before.snapshot.pages[0].revision,
    );
    expect(after.snapshot.pages[0].sourceFingerprint).not.toBe(
      before.snapshot.pages[0].sourceFingerprint,
    );
    expect(f.fonts).toHaveBeenCalledTimes(3);
  } finally {
    await f.close();
  }
});

it.each(["chapter title", "page name", "source filename"])(
  "rejects %s changing during source capture",
  async (field) => {
    const f = await compositeNativeSourcesFixture();
    try {
      let reads = 0;
      const nativeRead = f.options.readContext;
      f.options.readContext = async (id) => {
        const saved = await nativeRead(id);
        if (++reads > f.targets.length) {
          if (field === "chapter title")
            saved.chapter.title = "Renamed while inspecting";
          if (field === "page name")
            saved.chapter.pages[0].name = "Renamed while inspecting";
          if (field === "source filename")
            saved.chapter.pages[0].sourceFileName = "new-source.jpeg";
        }
        return saved;
      };
      await expect(f.read()).rejects.toMatchObject({
        code: "revision_conflict",
      });
    } finally {
      await f.close();
    }
  },
);

it("seals inactive native inline lettering values and does not treat an ordinary text edit as file replacement", async () => {
  const f = await compositeNativeSourcesFixture();
  try {
    const before = await f.read();
    const page = before.values[0].page;
    const blocks = structuredClone(page.blocks);
    blocks[0].translatedText = "A different editable translation";
    expect(
      f.native.compositePageSourceFingerprint(before.values[0].state, blocks),
    ).toBe(before.snapshot.pages[0].sourceFingerprint);
    blocks[0].generatedLettering = {
      version: 1,
      enabled: false,
      sourceText: "sound",
      translatedText: "소리",
      dataUrl: "data:image/png;base64,AAAA",
    };
    const inline = f.native.compositePageSourceFingerprint(
      before.values[0].state,
      blocks,
    );
    blocks[0].generatedLettering.dataUrl = "data:image/png;base64,AAAB";
    expect(
      f.native.compositePageSourceFingerprint(before.values[0].state, blocks),
    ).not.toBe(inline);
    expect(inline).not.toBe(before.snapshot.pages[0].sourceFingerprint);
  } finally {
    await f.close();
  }
});

it("keeps absent default context timestamps stable and freezes provider and permission policy", async () => {
  const f = await compositeNativeSourcesFixture();
  try {
    const first = await f.read();
    expect((await f.read()).snapshot).toEqual(first.snapshot);
    f.settings.api.model = "another-provider-model";
    const provider = await f.read();
    expect(provider.snapshot.policyFingerprint).not.toBe(
      first.snapshot.policyFingerprint,
    );
    f.options.preferences.allowProcessing = false;
    expect((await f.read()).snapshot.policyFingerprint).not.toBe(
      provider.snapshot.policyFingerprint,
    );
  } finally {
    await f.close();
  }
});

it("awaits fresh asynchronous settings reads on both sides of native source inspection", async () => {
  const f = await compositeNativeSourcesFixture();
  try {
    let reads = 0;
    const settings = async () => {
      const value = structuredClone(f.settings);
      if (++reads === 2) value.api.model = "changed-during-source-pass";
      return value;
    };
    await expect(
      f.native.readMcpCompositeSources(f.targets, f.plan, f.guard, {
        ...f.options,
        settings,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(reads).toBe(2);
  } finally {
    await f.close();
  }
});
