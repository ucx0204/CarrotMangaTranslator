// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import {
  readBackupPreferences,
  restoreBackupPreferences,
} from "../src/renderer/src/lib/environmentBackupPreferences";

afterEach(() => window.localStorage.clear());
describe("portable UI preferences", () => {
  it("serializes only the explicit preferences, excluding credentials and recent paths", () => {
    window.localStorage.setItem("library-sort", "title");
    window.localStorage.setItem("editor.richText.mode", "code");
    window.localStorage.setItem("auth.token", "SECRET");
    window.localStorage.setItem("recentFile", "C:/private/file.png");
    expect(readBackupPreferences()).toEqual({
      "library-sort": "title",
      "editor.richText.mode": "code",
    });
  });
  it("applies the receipt once and keeps subsequent user changes", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      getEnvironmentRestoreReceipt: async () => ({
        id: "receipt",
        ui: { "library-sort": "title" },
        connections: [],
      }),
    });
    window.localStorage.setItem("editor.richText.mode", "code");
    window.localStorage.setItem("unrelated", "keep");
    await restoreBackupPreferences();
    expect(window.localStorage.getItem("library-sort")).toBe("title");
    expect(window.localStorage.getItem("editor.richText.mode")).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
    window.localStorage.setItem("library-sort", "date");
    await restoreBackupPreferences();
    expect(window.localStorage.getItem("library-sort")).toBe("date");
  });
  it("leaves an ordinary startup unchanged", async () => {
    window.mangaApi = createTestMangaGatewayStub();
    window.localStorage.setItem("library-sort", "date");
    await restoreBackupPreferences();
    expect(window.localStorage.getItem("library-sort")).toBe("date");
    expect(
      window.localStorage.getItem("environment-backup.applied"),
    ).toBeNull();
  });
});
