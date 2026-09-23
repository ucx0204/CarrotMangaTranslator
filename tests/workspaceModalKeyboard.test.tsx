/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Modal } from "../src/renderer/src/components/ui/Modal";
import { useWorkspaceBubbleLayoutHandlers } from "../src/renderer/src/hooks/useWorkspaceBubbleLayoutHandlers";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import {
  appendBubbleLayoutPolygonPoint,
  createBubbleLayoutDraft,
} from "../src/renderer/src/lib/bubbleLayoutDraft";
import { makePage } from "./helpers/workspacePointerFixtures";

afterEach(cleanup);

it.each(["Enter", "Backspace"])(
  "preserves a background bubble draft when a modal receives %s",
  (key) => {
    const page = makePage();
    const block = page.blocks[0];
    const store = createWorkspaceInteractionPreviewStore();
    const updateCurrentChapter = vi.fn();
    renderHook(() =>
      useWorkspaceBubbleLayoutHandlers({
        active: true,
        getImagePointerRect: () => null,
        interactionPreviewStore: store,
        onFinished: vi.fn(),
        pushStatus: vi.fn(),
        selectedBlockId: block.id,
        selectedPage: page,
        selectedPageEditLocked: false,
        stageRef: React.createRef<HTMLDivElement>(),
        updateCurrentChapter,
      }),
    );
    const before = [
      { x: 100, y: 100 },
      { x: 800, y: 100 },
      { x: 800, y: 800 },
      { x: 100, y: 800 },
    ].reduce(
      appendBubbleLayoutPolygonPoint,
      createBubbleLayoutDraft(block, page),
    );
    store.set({ bubbleLayoutDraft: before });
    const view = render(
      <Modal title="Settings" onClose={vi.fn()}>
        <p>Settings</p>
      </Modal>,
    );
    fireEvent.keyDown(view.getByRole("dialog"), { key });
    expect(store.getBubbleLayoutDraft()).toEqual(before);
    expect(updateCurrentChapter).not.toHaveBeenCalled();
    view.unmount();
    fireEvent.keyDown(window, { key });
    expect(store.getBubbleLayoutDraft()).not.toEqual(before);
    expect(updateCurrentChapter).toHaveBeenCalledTimes(key === "Enter" ? 1 : 0);
  },
);
