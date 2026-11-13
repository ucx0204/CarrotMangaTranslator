import { z } from "zod/v4";
import {
  parseMcpStoredJob,
  type McpStoredJob,
} from "../src/main/application/mcpJobJournal";
import {
  summarizeMcpJob,
  type McpJobPersistence,
} from "../src/main/application/mcpJobPersistence";

/** Adapts old snapshot fault-injection fixtures, never used by production. */
export function jobPersistenceFixture(legacy: {
  load: () => Promise<unknown>;
  save: (value: unknown) => Promise<void>;
}): McpJobPersistence {
  const records = new Map<string, McpStoredJob>();
  const revisions = new Map<string, number>();
  return {
    open: async () => {
      const value = await legacy.load();
      if (value != null)
        for (const record of z
          .object({ version: z.literal(1), records: z.array(z.unknown()) })
          .strict()
          .parse(value)
          .records.map(parseMcpStoredJob)) {
          records.set(record.id, record);
          revisions.set(record.id, 1);
        }
      return [...records.values()].map((record) =>
        summarizeMcpJob(record, revisions.get(record.id) ?? 1),
      );
    },
    read: async (id) => {
      const record = records.get(id);
      if (!record) throw new Error("Missing fixture job");
      return structuredClone(record);
    },
    save: async (record, expected) => {
      if ((revisions.get(record.id) ?? null) !== expected)
        throw new Error("Fixture revision conflict");
      const next = new Map(records).set(record.id, structuredClone(record));
      await legacy.save({ version: 1, records: [...next.values()] });
      records.set(record.id, structuredClone(record));
      revisions.set(record.id, (expected ?? 0) + 1);
      return summarizeMcpJob(record, (expected ?? 0) + 1);
    },
    update: async (id, expected, changes) => {
      const record = records.get(id);
      if (!record || revisions.get(id) !== expected)
        throw new Error("Fixture revision conflict");
      const { expiresAt: _expiry, ...fields } = changes;
      const next = { ...record, ...fields };
      await legacy.save({
        version: 1,
        records: [...records.values()].map((r) => (r.id === id ? next : r)),
      });
      records.set(id, next);
      revisions.set(id, expected + 1);
      return summarizeMcpJob(next, expected + 1);
    },
    remove: async (id) => {
      const next = new Map(records);
      next.delete(id);
      await legacy.save({ version: 1, records: [...next.values()] });
      records.delete(id);
      revisions.delete(id);
    },
    cleanup: async () => {},
  };
}
