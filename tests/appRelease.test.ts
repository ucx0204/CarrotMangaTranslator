import { describe, expect, it } from "vitest";
import {
  APP_RELEASE_OWNER,
  APP_RELEASE_REPO,
  APP_RELEASES_URL,
  APP_NEW_ISSUE_URL,
} from "../src/shared/appRelease";

describe("app release coordinates", () => {
  it("builds the GitHub releases URL from the configured owner/repo", () => {
    expect(APP_RELEASES_URL).toBe(
      `https://github.com/${APP_RELEASE_OWNER}/${APP_RELEASE_REPO}/releases`,
    );
  });

  it("matches the electron-builder publish target", () => {
    expect(APP_RELEASE_OWNER).toBe("ucx0204");
    expect(APP_RELEASE_REPO).toBe("CarrotMangaTranslator");
  });

  it("builds the GitHub new issue URL from the same coordinates", () => {
    expect(APP_NEW_ISSUE_URL).toBe(
      `https://github.com/${APP_RELEASE_OWNER}/${APP_RELEASE_REPO}/issues/new`,
    );
  });
});
