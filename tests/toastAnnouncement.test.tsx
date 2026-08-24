/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToastViewport } from "../src/renderer/src/components/ui/ToastViewport";
import {
  dismissToast,
  getToasts,
  toast,
} from "../src/renderer/src/lib/toastStore";

afterEach(() => {
  cleanup();
  for (const item of getToasts()) {
    dismissToast(item.id);
  }
});

function roleOf(message: string): string | null {
  return (
    screen.getByText(message).closest("[role]")?.getAttribute("role") ?? null
  );
}

describe("toast announcements", () => {
  it("interrupts for failures and waits its turn for everything else", () => {
    render(<ToastViewport />);

    act(() => {
      toast.success("saved", { duration: 0 });
      toast.info("running", { duration: 0 });
      toast.warn("partially done", { duration: 0 });
      toast.error("export failed", { duration: 0 });
    });

    expect(roleOf("export failed")).toBe("alert");
    expect(roleOf("partially done")).toBe("alert");
    expect(roleOf("saved")).toBe("status");
    expect(roleOf("running")).toBe("status");
  });

  it("does not nest the per-toast live regions inside another one", () => {
    render(<ToastViewport />);
    act(() => {
      toast.error("export failed", { duration: 0 });
    });

    expect(screen.getByRole("region").getAttribute("aria-live")).toBeNull();
    expect(roleOf("export failed")).toBe("alert");
  });
});
