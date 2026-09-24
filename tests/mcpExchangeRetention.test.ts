import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { RetainedOutputSchema } from "../src/main/mcp/mcpRetentionRecords";
import {
  artifactToken,
  collectRetained,
  exchangeRetentionFixture,
} from "./mcpExchangeRetention.fixture";

it("reconstructs encrypted text/context bindings and exact bytes with no invented image targets", async () => {
  const f = await exchangeRetentionFixture();
  try {
    const chapter = await readFile(f.chapterPath);
    const outputs = await Promise.all([
      f.publish("text"),
      f.publish("context"),
    ]);
    const old = f.operations().artifacts;
    for (const output of outputs) {
      const record = RetainedOutputSchema.parse(
        await f.storage.record(output.id),
      );
      expect(record.targets).toEqual([]);
      expect(record.exchangeBinding).toEqual(output.source.binding);
      expect(
        (await f.storage.owned(f.owner, output.id, "output")).entry.pageCount,
      ).toBe(
        output.source.binding.kind === "text"
          ? output.source.binding.pages.length
          : 0,
      );
      const envelope = JSON.parse(
        await readFile(await f.storage.path(output.id), "utf8"),
      );
      expect(Object.keys(envelope)).toEqual(["encrypted"]);
      expect(await f.codec.open(envelope)).toEqual(record);
      expect(JSON.stringify(envelope)).not.toContain(
        output.source.binding.snapshot,
      );
      expect(
        (await f.savedBytes(output.id, output.sha256)).equals(
          output.source.bytes,
        ),
      ).toBe(true);
    }
    await f.restart();
    const session = f.session(false);
    for (const output of outputs) {
      await expect(old.read(artifactToken(output.url))).rejects.toThrow();
      const renewed = await f.issue(session, output.id);
      expect(renewed.url).not.toBe(output.url);
      expect(renewed.mimeType).toBe(output.mimeType);
      expect((await f.read(renewed)).equals(output.source.bytes)).toBe(true);
      const catalog = await session.catalog.output(
        f.owner,
        output.id,
        () => {},
      );
      expect(catalog.pages).toEqual(
        output.source.binding.kind === "text"
          ? output.source.binding.pages.map((page) => ({
              chapterId: "chapter",
              ...page,
            }))
          : [],
      );
      expect(catalog.canDownload).toBe(true);
      expect(JSON.stringify(catalog)).not.toMatch(
        /imagePath|sourceNameFingerprint|sourceFingerprint|"files"/,
      );
      expect(JSON.stringify(catalog)).not.toContain(f.env.root);
    }
    expect(await readFile(f.chapterPath)).toEqual(chapter);
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["text", "context"] as const)(
  "blocks retained %s after its saved source changes, and invalidates links on discard",
  async (kind) => {
    const f = await exchangeRetentionFixture();
    try {
      const output = await f.publish(kind);
      const session = f.session(false);
      const issued = await f.issue(session, output.id);
      const opened = await f
        .operations()
        .artifacts.open(
          artifactToken(issued.url),
          kind === "text" ? "review.csv" : "context.json",
        );
      if (kind === "text") {
        const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
        chapter.pages[0].blocks[0].translatedText =
          "Saved after the reviewed exchange export";
        await writeFile(f.chapterPath, JSON.stringify(chapter));
      } else {
        const guide = await f.library.getWorkStyleGuide("work");
        guide.rules.honorifics =
          guide.rules.honorifics === "drop" ? "preserve" : "drop";
        await f.library.saveWorkStyleGuide(guide);
      }
      await expect(f.issue(session, output.id)).rejects.toMatchObject({
        code: "revision_conflict",
      });
      await expect(collectRetained(opened.stream())).rejects.toMatchObject({
        code: "revision_conflict",
      });
      await expect(
        session.catalog.output(f.owner, output.id, () => {}),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      expect(
        (await f.savedBytes(output.id, output.sha256)).equals(
          output.source.bytes,
        ),
      ).toBe(true);
      expect(
        (await session.catalog.diagnoseOutput(f.owner, output.id, () => {}))
          .retention,
      ).toMatchObject({
        state: "retained",
        content: "verified",
        source: "stale",
        access: "blocked",
      });
      await session.catalog.discard(f.owner, output.id, () => {});
      await expect(f.issue(session, output.id)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(f.read(issued)).rejects.toThrow();
      expect((await f.list("outputs")).total).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it("rechecks the native text binding after encrypted staging and publishes no stale receipt", async () => {
  const f = await exchangeRetentionFixture();
  let restore = () => {};
  try {
    const changed = JSON.parse(await readFile(f.chapterPath, "utf8"));
    changed.pages[0].blocks[0].translatedText = "Concurrent saved text";
    const encrypted = f.encryption.encrypt;
    let injected = false;
    const hook = vi
      .spyOn(f.encryption, "encrypt")
      .mockImplementation((text) => {
        const result = encrypted(text);
        if (
          !injected &&
          JSON.parse(text).payload?.exchangeBinding?.kind === "text"
        ) {
          injected = true;
          writeFileSync(f.chapterPath, JSON.stringify(changed));
        }
        return result;
      });
    restore = () => hook.mockRestore();
    await expect(f.publish("text")).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(injected).toBe(true);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(JSON.parse(await readFile(f.chapterPath, "utf8"))).toEqual(changed);
  } finally {
    restore();
    await f.close();
  }
});
