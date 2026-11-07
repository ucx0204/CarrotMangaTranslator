import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ChatService } from "../src/main/application/chatService";
import { ChatRepository } from "../src/main/chat/chatRepository";
import { chatFixture } from "./helpers/chatFixture";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => process.cwd(),
    getLocale: () => "ko",
  },
}));

it("removes only the selected chat's copies and summary, preserving originals, library, outputs and other chats", async () => {
  const f = await chatFixture();
  try {
    const other = await f.service.create();
    const image = await f.service.attachImage(
      f.session.id,
      "original.png",
      "data:image/png;base64,AA==",
    );
    const sibling = await f.service.attachImage(
      other.id,
      "other.png",
      "data:image/png;base64,AQ==",
    );
    const directory = join(f.root, "chat", f.session.id);
    const preserved = [
      "original.png",
      "library/page.png",
      "outputs/result.png",
      `chat/${f.session.id}/unknown.txt`,
    ];
    for (const name of preserved) {
      const path = join(f.root, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `keep:${name}`);
    }
    await f.service.list();
    await f.service.delete(f.session.id);
    await expect(
      f.repository.image(f.session.id, image.id),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(f.root, "chat", "summaries", `${f.session.id}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual(["unknown.txt"]);
    expect(await f.repository.image(other.id, sibling.id)).toEqual(sibling);
    for (const name of preserved)
      expect(await readFile(join(f.root, name), "utf8")).toBe(`keep:${name}`);
    expect(f.deleteNativeSession).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

it("serializes attachment and summary writes before deletion and rejects late writes", async () => {
  const f = await chatFixture();
  try {
    const record = await f.repository.read(f.session.id);
    const attachment = f.repository.addImage(
      record.id,
      "in-flight.png",
      "data:image/png;base64,AA==",
    );
    const listing = f.repository.list();
    await attachment;
    await listing;
    const nextAttachment = f.repository.addImage(
      record.id,
      "racing.png",
      "data:image/png;base64,AA==",
    );
    const deletion = f.service.delete(record.id);
    await nextAttachment;
    await deletion;
    await expect(
      readdir(join(f.root, "chat", record.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.repository.save(record)).rejects.toThrow("삭제된");
    await expect(
      f.service.attachImage(
        record.id,
        "late.png",
        "data:image/png;base64,AA==",
      ),
    ).rejects.toThrow("삭제된");
    expect(await new ChatRepository(f.root).list()).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

it("preserves a non-directory attachment path and the conversation when cleanup cannot safely enumerate it", async () => {
  const f = await chatFixture();
  try {
    const path = join(f.root, "chat", f.session.id);
    await writeFile(path, "unexpected user file");
    await expect(f.service.delete(f.session.id)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    expect(await readFile(path, "utf8")).toBe("unexpected user file");
    expect((await f.repository.read(f.session.id)).id).toBe(f.session.id);
  } finally {
    await f.cleanup();
  }
});

it.each(["attachments", "summary", "image"])(
  "refuses a %s junction without touching the target or deleting the conversation",
  async (kind) => {
    const f = await chatFixture();
    let link: string | undefined;
    try {
      const target = join(f.root, "library");
      await mkdir(target);
      await writeFile(join(target, "original.png"), "original");
      const chat = join(f.root, "chat");
      link =
        kind === "summary"
          ? join(chat, "summaries")
          : kind === "attachments"
            ? join(chat, f.session.id)
            : join(chat, f.session.id, `${randomUUID()}.json`);
      await mkdir(join(link, ".."), { recursive: true });
      await symlink(target, link, "junction");
      await expect(f.service.delete(f.session.id)).rejects.toThrow(/symlink/);
      expect(await readFile(join(target, "original.png"), "utf8")).toBe(
        "original",
      );
      expect((await f.repository.read(f.session.id)).id).toBe(f.session.id);
    } finally {
      if (link) await rmdir(link);
      await f.cleanup();
    }
  },
);

it("deletes a restored native thread first, preserves retry data on failure, and does not reconnect chat", async () => {
  const f = await chatFixture();
  let restored: ChatService | undefined;
  try {
    const nativeThreadId = randomUUID();
    await f.dispose();
    await f.repository.save({
      ...(await f.repository.read(f.session.id)),
      nativeThreadId,
    });
    const image = await f.repository.addImage(
      f.session.id,
      "copy.png",
      "data:image/png;base64,AA==",
    );
    const failure = new Error("native disk failure");
    f.deleteNativeSession.mockRejectedValueOnce(failure);
    restored = new ChatService({
      repository: f.repository,
      runtime: f.connect,
      deleteNativeSession: f.deleteNativeSession,
      publish: vi.fn(),
      reportError: f.errors,
    });
    await expect(restored.delete(f.session.id)).rejects.toBe(failure);
    expect((await f.repository.read(f.session.id)).nativeThreadId).toBe(
      nativeThreadId,
    );
    expect(await f.repository.image(f.session.id, image.id)).toEqual(image);
    await restored.delete(f.session.id);
    expect(f.deleteNativeSession).toHaveBeenCalledTimes(2);
    expect(f.connect).not.toHaveBeenCalled();
    expect(await f.repository.list()).toEqual([]);
  } finally {
    await restored?.dispose();
    await f.cleanup();
  }
});

it("persists native deletion before retrying a failed local deletion", async () => {
  const f = await chatFixture();
  let restored: ChatService | undefined;
  try {
    await f.dispose();
    await f.repository.save({
      ...(await f.repository.read(f.session.id)),
      nativeThreadId: randomUUID(),
    });
    const deletion = vi
      .spyOn(f.repository, "delete")
      .mockRejectedValueOnce(new Error("local disk failure"));
    restored = new ChatService({
      repository: f.repository,
      runtime: f.connect,
      deleteNativeSession: f.deleteNativeSession,
      publish: vi.fn(),
      reportError: f.errors,
    });
    await expect(restored.delete(f.session.id)).rejects.toThrow(
      "local disk failure",
    );
    expect((await f.repository.read(f.session.id)).nativeThreadId).toBeNull();
    await restored.delete(f.session.id);
    expect(deletion).toHaveBeenCalledTimes(2);
    expect(f.deleteNativeSession).toHaveBeenCalledOnce();
  } finally {
    await restored?.dispose();
    await f.cleanup();
  }
});
