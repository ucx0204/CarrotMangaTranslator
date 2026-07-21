import { describe, expect, it } from "vitest";
import {
  APP_RELEASE_OWNER,
  APP_RELEASE_REPO,
  APP_RELEASES_URL,
  APP_NEW_ISSUE_URL,
  APP_ISSUES_URL,
  APP_MAC_ALPHA_ISSUE_URL,
  resolveMacIssueMenuTarget,
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

  it("routes stable macOS builds away from the Alpha issue template", () => {
    expect(resolveMacIssueMenuTarget(false)).toEqual({
      labelKey: "errorReport.openIssues",
      url: APP_ISSUES_URL,
    });
    expect(resolveMacIssueMenuTarget(true)).toEqual({
      labelKey: "macAlpha.reportIssueMenu",
      url: APP_MAC_ALPHA_ISSUE_URL,
    });
  });
});
