import { describe, expect, it, vi } from "vitest";
import { ipcEventContracts } from "../src/shared/ipcEventContracts";
import { emitPageTimingUpdated } from "../src/main/jobs/pageTimingEvents";
import type { JobEventWindow } from "../src/main/jobs/jobEventDispatchQueue";

const CHAPTER_ID = "00000000-0000-4000-8000-000000000001";
const PAGE_ID = "00000000-0000-4000-8000-000000000002";

describe("page timing update events", () => {
  it("validates and sends a timing-only refresh event", () => {
    const send = vi.fn();
    const window = makeWindow(send);
    const event = { chapterId: CHAPTER_ID, pageIds: [PAGE_ID] };

    emitPageTimingUpdated(window, event);

    expect(send).toHaveBeenCalledWith(
      ipcEventContracts.pageTimingUpdated.channel,
      event,
    );
  });

  it("does not send through a destroyed window", () => {
    const send = vi.fn();

    emitPageTimingUpdated(makeWindow(send, true), {
      chapterId: CHAPTER_ID,
      pageIds: [PAGE_ID],
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an invalid event before it reaches the renderer", () => {
    const send = vi.fn();

    expect(() =>
      emitPageTimingUpdated(makeWindow(send), {
        chapterId: "not-a-uuid",
        pageIds: [PAGE_ID],
      }),
    ).toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

function makeWindow(
  send: (channel: string, event: unknown) => void,
  destroyed = false,
): JobEventWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => false,
      send,
    },
  };
}
