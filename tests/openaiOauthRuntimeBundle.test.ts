import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAllowedNativeImport,
  OPENAI_OAUTH_RUNTIME_RELATIVE_PATH,
} from "../src/main/nativeDynamicImport";
import { resolveResourceOpenAIOAuthEntryPath } from "../src/main/openaiOauthEndpoint";

const repoRoot = join(__dirname, "..");
const temporaryDirectories: string[] = [];

type OAuthRuntimeBundler = {
  OPENAI_OAUTH_LICENSES_FILENAME: string;
  OPENAI_OAUTH_RUNTIME_FILENAME: string;
  bundleOpenAIOAuthRuntime: (options: {
    root: string;
    outputFile: string;
  }) => Promise<string>;
};

const {
  OPENAI_OAUTH_LICENSES_FILENAME,
  OPENAI_OAUTH_RUNTIME_FILENAME,
  bundleOpenAIOAuthRuntime,
} =
  require("../scripts/bundle-openai-oauth-runtime.cjs") as OAuthRuntimeBundler;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("openai-oauth packaged runtime bundle", () => {
  it("creates one importable ESM resource without an unpacked dependency tree", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-oauth-runtime-"));
    temporaryDirectories.push(temporaryRoot);
    const resourcesDirectory = join(temporaryRoot, "resources");
    const outputDirectory = join(resourcesDirectory, "app-runtime");
    const outputFile = join(outputDirectory, OPENAI_OAUTH_RUNTIME_FILENAME);

    await expect(
      bundleOpenAIOAuthRuntime({ root: repoRoot, outputFile }),
    ).resolves.toBe(outputFile);
    expect(existsSync(outputFile)).toBe(true);
    const licenses = readFileSync(
      join(outputDirectory, OPENAI_OAUTH_LICENSES_FILENAME),
      "utf8",
    );
    expect(licenses).toContain("Package: openai-oauth@");
    expect(licenses).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(licenses).toContain("Package: ai@");
    expect(licenses).toContain("Package: zod@");

    const resourceUrl = `${pathToFileURL(outputFile).href}?test=${Date.now()}`;
    expect(OPENAI_OAUTH_RUNTIME_RELATIVE_PATH).toBe(
      join("app-runtime", OPENAI_OAUTH_RUNTIME_FILENAME),
    );
    expect(resolveResourceOpenAIOAuthEntryPath(resourcesDirectory)).toBe(
      outputFile,
    );
    expect(() =>
      assertAllowedNativeImport(resourceUrl, resourcesDirectory),
    ).not.toThrow();
    expect(() =>
      assertAllowedNativeImport(
        pathToFileURL(
          join(
            temporaryRoot,
            "untrusted",
            "app-runtime",
            OPENAI_OAUTH_RUNTIME_FILENAME,
          ),
        ).href,
        resourcesDirectory,
      ),
    ).toThrow("허용되지 않은 동적 모듈 import입니다");

    const runtime = (await import(resourceUrl)) as {
      startOpenAIOAuthServer?: (options: {
        host: string;
        port: number;
      }) => Promise<{
        port: number;
        url: string;
        close: () => Promise<void>;
      }>;
    };
    expect(runtime.startOpenAIOAuthServer).toBeTypeOf("function");
    if (typeof runtime.startOpenAIOAuthServer !== "function") {
      throw new Error("Bundled OAuth server export is missing.");
    }

    const server = await runtime.startOpenAIOAuthServer({
      host: "127.0.0.1",
      port: 0,
    });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    } finally {
      await server.close();
    }
  });
});
