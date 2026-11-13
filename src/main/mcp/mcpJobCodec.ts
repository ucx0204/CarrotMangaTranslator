import { isDeepStrictEqual } from "node:util";
import { z } from "zod/v4";
import type { JobCodec } from "./mcpJobStorageSchema";

type Encryption = {
  available: () => boolean;
  encrypt: (text: string) => Buffer;
  decrypt: (bytes: Buffer) => string;
};
const envelope = z
  .object({
    domain: z.literal("carrot-job-v2"),
    profile: z.string(),
    binding: z.unknown(),
    payload: z.unknown(),
  })
  .strict();
export function createMcpJobCodec(
  encryption: Encryption,
  profile: () => Promise<string>,
): JobCodec {
  const available = () => {
    if (!encryption.available())
      throw new Error("OS-backed MCP encryption is unavailable.");
  };
  return {
    seal: async (binding, payload) => {
      available();
      const value = {
        domain: "carrot-job-v2",
        profile: await profile(),
        binding,
        payload,
      };
      return Buffer.from(
        encryption.encrypt(JSON.stringify(value)).toString("base64"),
      );
    },
    open: async (binding, bytes) => {
      available();
      const decoded = Buffer.from(bytes.toString("ascii"), "base64");
      if (decoded.toString("base64") !== bytes.toString("ascii"))
        throw new Error("Invalid job encryption envelope.");
      const value = envelope.parse(JSON.parse(encryption.decrypt(decoded)));
      if (
        value.profile !== (await profile()) ||
        !isDeepStrictEqual(value.binding, binding)
      )
        throw new Error("Job profile or identity binding mismatch.");
      return value.payload;
    },
  };
}
