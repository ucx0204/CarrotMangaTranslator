import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  planMcpContextChanges,
  type McpContextPlanOptions,
  type McpContextSnapshot,
} from "../src/main/application/mcpContextEditPolicy";
import {
  mcpContextRevision,
  type McpContextChange,
} from "../src/shared/mcpContextEditing";

const timestamp = "2026-09-17T00:00:00.000Z";
function snapshot(): McpContextSnapshot {
  const workId = randomUUID();
  const chapterId = randomUUID();
  return {
    workId,
    workTitle: "Synthetic change-ID fixture",
    chapter: {
      id: chapterId,
      workId,
      title: "Fixture",
      sourceKind: "images",
      status: "idle",
      pageOrder: [],
      pages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    styleGuide: {
      schemaVersion: 1,
      workId,
      glossary: [],
      characters: [],
      rules: {
        honorifics: "adapt",
        sfxMode: "translate",
        defaultTone: "natural_korean",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    storyMemory: {
      schemaVersion: 1,
      workId,
      chapterId,
      pages: [],
      updatedAt: timestamp,
    },
  };
}

const cases = ["__proto__", "constructor", "toString"].flatMap(
  (changeId) =>
    [
      ["glossary", changeId],
      ["character", changeId],
    ] as const,
);
it.each(cases)(
  "treats %s change ID %s as an own data key with stable preview identity",
  (entity, changeId) => {
    const initial = snapshot();
    const before = structuredClone(initial);
    const options: McpContextPlanOptions = {
      now: timestamp,
      origin: "manual",
      entryIds: {},
    };
    const change: McpContextChange =
      entity === "glossary"
        ? { entity, changeId, values: { source: "fixture", target: "test" } }
        : { entity, changeId, values: { displayName: "fixture" } };
    const input = {
      chapterId: initial.chapter.id,
      revision: mcpContextRevision(initial),
      requestId: randomUUID(),
      changes: [change],
    };
    const first = planMcpContextChanges(initial, input, options);
    const second = planMcpContextChanges(initial, input, options);
    const id = first.changes[0].targetId;
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(Object.hasOwn(options.entryIds, changeId)).toBe(true);
    expect(Object.getPrototypeOf(options.entryIds)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(options.entryIds, changeId)).toEqual(
      { value: id, writable: true, enumerable: true, configurable: true },
    );
    expect(second).toEqual(first);
    expect(first.guideChanged).toBe(true);
    expect(first.memoryChanged).toBe(false);
    expect(initial).toEqual(before);

    const applied = { ...initial, styleGuide: first.styleGuide };
    expect(() =>
      planMcpContextChanges(
        applied,
        { ...input, revision: mcpContextRevision(applied) },
        options,
      ),
    ).toThrow(/already in use/);
  },
);
