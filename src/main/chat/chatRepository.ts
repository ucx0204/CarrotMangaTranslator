import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { chatImagePreview } from "./chatImagePreview";
import { chatSummary } from "../../shared/chatSnapshot";
import {
  ChatImageSchema,
  ChatSessionSchema,
  ChatSummarySchema,
} from "../../shared/chatSchemas";
import type {
  ChatImage,
  ChatSession,
  ChatSummary,
} from "../../shared/chatTypes";
import {
  writeDurableJsonFile,
  assertPathWithinRootWithoutSymlinks,
} from "../libraryStore/libraryTransactionStorage";

/** Global app data; no manga directory, source file or linked output is written. */
export class ChatRepository {
  private readonly root: string;
  private readonly writes = new Map<string, Promise<void>>();
  private readonly deleted = new Set<string>();
  private readonly summaries = new Map<
    string,
    { stamp: string; summary: ChatSummary }
  >();
  constructor(dataRoot: string) {
    this.root = join(dataRoot, "chat");
  }
  async list(): Promise<ChatSummary[]> {
    await mkdir(this.root, { recursive: true });
    const names = await readdir(this.root);
    const sessions: ChatSummary[] = [];
    // A cold migration reads one transcript at a time; later lists use summaries.
    for (const name of names.filter((value) =>
      /^[a-f0-9-]{36}\.json$/i.test(value),
    )) {
      const id = name.slice(0, -5);
      try {
        sessions.push(await this.enqueue(id, () => this.summary(id)));
      } catch (error) {
        sessions.push({
          id,
          title: "읽을 수 없는 대화",
          state: "failed",
          updatedAt: 0,
          runtime: "codex",
          model: null,
          effort: null,
          loadError: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private async summary(id: string): Promise<ChatSummary> {
    const info = await stat(await this.path(`${checkedId(id)}.json`));
    const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    const cached = this.summaries.get(id);
    if (cached?.stamp === stamp) return cached.summary;
    const path = await this.path(`summaries/${id}.json`);
    try {
      const index = JSON.parse(await readFile(path, "utf8")) as {
        stamp?: string;
        summary?: unknown;
      };
      if (index.stamp === stamp) {
        const summary = ChatSummarySchema.parse(index.summary);
        if (summary.id === id) {
          this.summaries.set(id, { stamp, summary });
          return summary;
        }
      }
    } catch (_error) {
      // error-policy-allow: a missing/corrupt derived index is rebuilt from the original record.
    }
    const session = await this.read(id);
    const summary = chatSummary(session);
    this.summaries.set(id, { stamp, summary });
    try {
      await writeDurableJsonFile(path, { stamp, summary });
    } catch (error) {
      console.error("Chat summary cache write failed", error);
    }
    return summary;
  }
  async read(id: string): Promise<ChatSession> {
    return ChatSessionSchema.parse(
      JSON.parse(
        await readFile(await this.path(`${checkedId(id)}.json`), "utf8"),
      ),
    );
  }
  save(session: ChatSession): Promise<void> {
    const snapshot = structuredClone(ChatSessionSchema.parse(session));
    return this.enqueue(session.id, async () =>
      writeDurableJsonFile(
        await this.path(`${checkedId(snapshot.id)}.json`),
        snapshot,
      ),
    );
  }
  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    checkedId(id);
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // error-policy-allow: the prior caller owns its rejection; a new save may recover.
      })
      .then(() => {
        if (this.deleted.has(id)) throw new Error("삭제된 대화입니다.");
        return operation();
      });
    const settled = next.then(() => {});
    this.writes.set(id, settled);
    void settled
      .finally(() => {
        if (this.writes.get(id) === settled) this.writes.delete(id);
      })
      .catch(() => {
        // error-policy-allow: the original write rejection is returned to the caller.
      });
    return next;
  }
  async delete(id: string): Promise<void> {
    return this.enqueue(id, async () => {
      const record = await this.path(`${id}.json`);
      const summary = await this.path(`summaries/${id}.json`);
      const directory = await this.path(id);
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      const attachments: string[] = [];
      for (const entry of entries) {
        if (
          !z
            .string()
            .uuid()
            .safeParse(entry.name.replace(/\.json$/, "")).success ||
          !entry.name.endsWith(".json")
        )
          continue;
        const path = await this.path(`${id}/${entry.name}`);
        if (entry.isFile()) attachments.push(path);
      }
      // Preflight every owned path before deleting. Unknown files/directories
      // remain; never traverse or recursively remove a conversation folder.
      for (const path of attachments) await unlink(path);
      await rm(summary, { force: true });
      await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      });
      await unlink(record);
      this.summaries.delete(id);
      this.deleted.add(id);
    });
  }
  async addImage(
    sessionId: string,
    name: string,
    dataUrl: string,
  ): Promise<ChatImage> {
    return this.enqueue(sessionId, async () => {
      await this.read(sessionId);
      if (
        !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
          dataUrl,
        ) ||
        dataUrl.length > 28 * 1024 * 1024
      )
        throw new Error("PNG, JPEG, WebP 이미지를 20 MB 이하로 첨부해 주세요.");
      const image = { id: randomUUID(), name, dataUrl };
      await writeDurableJsonFile(
        await this.path(`${sessionId}/${image.id}.json`),
        image,
      );
      return image;
    });
  }
  async image(
    sessionId: string,
    imageId: string,
    preview = false,
  ): Promise<ChatImage> {
    const image = ChatImageSchema.parse(
      JSON.parse(
        await readFile(
          await this.path(`${checkedId(sessionId)}/${checkedId(imageId)}.json`),
          "utf8",
        ),
      ),
    );
    return preview ? chatImagePreview(image) : image;
  }
  private async path(name: string) {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, name);
    await assertPathWithinRootWithoutSymlinks(this.root, path, {
      allowMissingTarget: true,
    });
    return path;
  }
}
function checkedId(value: string) {
  return z.string().uuid().parse(value);
}
