/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SoundEffectImageRecoveryAction } from "../src/renderer/src/components/SoundEffectImageRecoveryAction";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { AppActivityResource } from "../src/shared/appActivityTypes";
import type { SoundEffectImageRecovery } from "../src/shared/analysisTypes";
import { makeChapter } from "./unifiedInpaintingUiFixtures";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "mangaApi");
});
const chapter = makeChapter();
const recovery: SoundEffectImageRecovery = {
  runId: "run",
  chapterId: chapter.id,
  blockCount: 1,
  eraseOriginal: true,
  output: "image",
  targets: [{ pageId: chapter.pages[0].id, pageRevision: "revision" }],
};
it.each(["local", "auth", "page"])(
  "checks the actual %s resource before continuing images",
  async (kind) => {
    const resource: AppActivityResource =
      kind === "local"
        ? { kind: "model-runtime", scope: "*", access: "write" }
        : kind === "auth"
          ? { kind: "codex-auth", scope: "*", access: "write" }
          : {
              kind: "page-content",
              scope: `${chapter.id}/${chapter.pages[0].id}`,
              access: "write",
            };
    window.mangaApi = createTestMangaGatewayStub({
      getSoundEffectImageRecovery: async () => recovery,
      getAppActivities: async () => ({
        version: 1,
        pages: [],
        activities: [
          {
            id: "other",
            category: "job",
            kind: "gemma-analysis",
            startedAt: 0,
            mutatesLibrary: true,
            blocksQuit: true,
            resources: [resource],
          },
        ],
      }),
    });
    const onResume = vi.fn();
    render(
      <SoundEffectImageRecoveryAction
        chapter={chapter}
        disabled={false}
        onResume={onResume}
      />,
    );
    const button = await screen.findByRole("button", {
      name: /이미지 작업 이어서/,
    });
    expect((button as HTMLButtonElement).disabled).toBe(kind !== "local");
    fireEvent.click(button);
    expect(onResume).toHaveBeenCalledTimes(kind === "local" ? 1 : 0);
    if (kind === "local") expect(onResume).toHaveBeenCalledWith(recovery);
  },
);
it("ignores an older chapter's response and reports a failed recovery read", async () => {
  let finish: (value: SoundEffectImageRecovery) => void = () => {};
  const get = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error("missing sidecar"));
  window.mangaApi = createTestMangaGatewayStub({
    getSoundEffectImageRecovery: get,
  });
  const { rerender } = render(
    <SoundEffectImageRecoveryAction
      chapter={chapter}
      disabled={false}
      onResume={vi.fn()}
    />,
  );
  rerender(
    <SoundEffectImageRecoveryAction
      chapter={{ ...chapter, id: "next" }}
      disabled={false}
      onResume={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("missing sidecar"),
  );
  await act(async () => finish(recovery));
  expect(screen.queryByRole("button")).toBeNull();
});
