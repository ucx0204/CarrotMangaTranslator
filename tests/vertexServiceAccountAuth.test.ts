import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVertexServiceAccountAccessTokenProvider,
  inspectVertexServiceAccountFile,
} from "../src/main/vertexServiceAccountAuth";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Vertex service-account authentication", () => {
  it("validates the Google credential shape without exposing the private key", async () => {
    const filePath = await writeCredential();

    await expect(inspectVertexServiceAccountFile(filePath)).resolves.toEqual({
      filePath,
      fileName: "vertex.json",
      projectId: "sample-project",
      clientEmail: "translator@sample-project.iam.gserviceaccount.com",
    });
  });

  it("rejects non-service-account and non-Google token configurations", async () => {
    const wrongType = await writeCredential({ type: "authorized_user" });
    await expect(inspectVertexServiceAccountFile(wrongType)).rejects.toThrow(
      "type 값이 service_account",
    );

    const wrongTokenUri = await writeCredential({
      token_uri: "https://credentials.invalid/token",
    });
    await expect(
      inspectVertexServiceAccountFile(wrongTokenUri),
    ).rejects.toThrow("Google 토큰 주소");
  });

  it("reuses the auth client and can force-refresh its cached token", async () => {
    const filePath = await writeCredential();
    const client = {
      credentials: {
        access_token: "cached-token" as string | undefined,
        expiry_date: Date.now() + 60_000,
      },
      getAccessToken: vi.fn().mockResolvedValue({ token: "fresh-token" }),
    };
    const createClient = vi.fn(() => client);
    const provider = createVertexServiceAccountAccessTokenProvider(filePath, {
      readFile,
      stat,
      createClient,
    });

    await expect(provider()).resolves.toBe("fresh-token");
    await expect(provider({ forceRefresh: true })).resolves.toBe("fresh-token");
    expect(createClient).toHaveBeenCalledOnce();
    expect(client.getAccessToken).toHaveBeenCalledTimes(2);
    expect(client.credentials.access_token).toBeUndefined();
    expect(client.credentials.expiry_date).toBe(0);
  });
});

async function writeCredential(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mgt-vertex-auth-"));
  tempDirectories.push(directory);
  const filePath = join(directory, "vertex.json");
  await writeFile(
    filePath,
    JSON.stringify({
      type: "service_account",
      project_id: "sample-project",
      private_key_id: "key-id",
      private_key:
        "-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END PRIVATE KEY-----\n",
      client_email: "translator@sample-project.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
      ...overrides,
    }),
    "utf8",
  );
  return filePath;
}
