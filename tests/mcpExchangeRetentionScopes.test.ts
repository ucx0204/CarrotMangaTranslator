import { expect, it } from "vitest";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import {
  artifactToken,
  collectRetained,
  exchangeRetentionFixture,
} from "./mcpExchangeRetention.fixture";

it("allows read-only retained text/context with images disabled while every image-bearing format stays gated", async () => {
  const f = await exchangeRetentionFixture();
  try {
    const text = await f.publish("text");
    const context = await f.publish("context");
    const image = await f.image();
    const images = [image, await f.zip(image.url), await f.work()];
    const calls: string[][] = [];
    const scopes = (value: readonly string[] = []) => {
      calls.push([...value]);
      if (value.some((scope) => scope !== "carrot.read"))
        throw new McpEditError("access_denied", "Read-only connection");
    };
    const caller = {
      principalId: f.owner,
      assertAuthorized: () => {},
      assertScopes: scopes,
      assertJobAuthorized: scopes,
    };
    const disabled = f.session(false);
    const enabled = f.session(true);
    const tool = disabled.tools.find(
      (item) => item.name === "carrot_get_output_file",
    );
    expect(tool).toMatchObject({
      readOnly: true,
      requiredScopes: ["carrot.read"],
    });
    await f.redaction(true);
    for (const output of [text, context]) {
      const renewed = await f.issue(disabled, output.id, caller);
      expect((await f.read(renewed)).equals(output.source.bytes)).toBe(true);
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.every((call) => call.length === 1 && call[0] === "carrot.read"),
    ).toBe(true);
    for (const output of images) {
      await expect(
        f.issue(disabled, output.id, f.auth()),
      ).rejects.toMatchObject({ code: "access_denied" });
      await expect(f.issue(enabled, output.id, caller)).rejects.toMatchObject({
        code: "access_denied",
      });
      await expect(
        f.issue(enabled, output.id, {
          principalId: f.owner,
          assertAuthorized: () => {},
        }),
      ).rejects.toMatchObject({ code: "access_denied" });
    }
    const catalog = await enabled.catalog.output(f.owner, image.id, () => {});
    expect(catalog.pages).toHaveLength(1);
    expect(Object.keys(catalog.pages[0]).sort()).toEqual([
      "chapterId",
      "pageId",
      "revision",
    ]);
    expect(JSON.stringify(catalog)).not.toMatch(
      /sourceNameFingerprint|sourceFingerprint|imagePath|"files"/,
    );
    expect(catalog.canDownload).toBe(false);
  } finally {
    await f.close();
  }
});

it("rechecks image scope and redaction at opening and when an already opened retained stream starts", async () => {
  const f = await exchangeRetentionFixture();
  try {
    const image = await f.image();
    const outputs = [image, await f.zip(image.url), await f.work()];
    const session = f.session(true);
    let permitted = true;
    const scope = (scopes: readonly string[] = []) => {
      if (!permitted && scopes.includes("carrot.images"))
        throw new McpEditError("access_denied", "Image permission revoked");
    };
    const caller = {
      principalId: f.owner,
      assertAuthorized: () => {},
      assertScopes: scope,
      assertJobAuthorized: scope,
    };
    const issued = await Promise.all(
      outputs.map((output) => f.issue(session, output.id, caller)),
    );
    const open = (url: string) =>
      f
        .operations()
        .artifacts.open(
          artifactToken(url),
          new URL(url).pathname.split("/").pop() ?? "",
        );
    const opened = await Promise.all(issued.map((output) => open(output.url)));
    permitted = false;
    for (const [index, output] of issued.entries()) {
      await expect(open(output.url)).rejects.toMatchObject({
        code: "access_denied",
      });
      await expect(
        collectRetained(opened[index].stream()),
      ).rejects.toMatchObject({ code: "access_denied" });
      await expect(
        f.issue(session, outputs[index].id, caller),
      ).rejects.toMatchObject({ code: "access_denied" });
    }
    permitted = true;
    const beforeRedaction = await Promise.all(
      issued.map((output) => open(output.url)),
    );
    await f.redaction(true);
    for (const item of beforeRedaction)
      await expect(collectRetained(item.stream())).rejects.toMatchObject({
        code: "access_denied",
      });
    for (const output of issued)
      await expect(open(output.url)).rejects.toMatchObject({
        code: "access_denied",
      });
  } finally {
    await f.close();
  }
});

it("keeps read authorization and session lifetime live for retained exchange links", async () => {
  const f = await exchangeRetentionFixture();
  try {
    const outputs = [await f.publish("text"), await f.publish("context")];
    const session = f.session(false);
    let authorized = true;
    const guard = () => {
      if (!authorized)
        throw new McpEditError("access_denied", "Read permission revoked");
    };
    const caller = {
      principalId: f.owner,
      assertAuthorized: guard,
      assertScopes: guard,
      assertJobAuthorized: guard,
    };
    const issued = await Promise.all(
      outputs.map((output) => f.issue(session, output.id, caller)),
    );
    const opened = await Promise.all(
      issued.map((output) =>
        f
          .operations()
          .artifacts.open(
            artifactToken(output.url),
            new URL(output.url).pathname.split("/").pop() ?? "",
          ),
      ),
    );
    authorized = false;
    for (const item of opened)
      await expect(collectRetained(item.stream())).rejects.toMatchObject({
        code: "access_denied",
      });
    for (const output of issued)
      await expect(f.read(output)).rejects.toMatchObject({
        code: "access_denied",
      });
    authorized = true;
    session.stop();
    for (const output of issued) await expect(f.read(output)).rejects.toThrow();
  } finally {
    await f.close();
  }
});
