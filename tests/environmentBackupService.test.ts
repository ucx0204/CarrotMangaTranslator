import { describe, expect, it, vi } from "vitest";
import {
  EnvironmentBackupService,
  type EnvironmentBackupPorts,
} from "../src/main/application/environmentBackupService";

function fixture() {
  const order: string[] = [];
  const preview = {
    id: "preview",
    createdAt: "2026-09-24",
    appVersion: "2.8.0",
    works: 1,
    pages: 2,
    bytes: 3,
    recoveryPath: "old",
    connections: [],
  };
  const ports: EnvironmentBackupPorts = {
    receipt: async () => null,
    status: async () => ({
      summary: { works: 1, pages: 2, bytes: 3 },
      recoveries: [],
      restored: null,
    }),
    discard: vi.fn(async () => {
      order.push("discard");
    }),
    pickExport: async () => "backup.zip",
    pickImport: async () => "backup.zip",
    exclusive: async (_kind, action) =>
      action(
        new AbortController().signal,
        () => undefined,
        () => {
          order.push("seal");
        },
      ),
    export: vi.fn(async () => {
      order.push("export");
    }),
    preview: vi.fn(async () => {
      order.push("preview");
      return preview;
    }),
    prepareRecovery: vi.fn(async () => {
      order.push("prepare");
      return "prepared";
    }),
    schedule: vi.fn(async () => {
      order.push("schedule");
    }),
    restart: vi.fn(() => {
      order.push("restart");
    }),
  };
  return { service: new EnvironmentBackupService(ports), ports, order };
}

describe("environment backup orchestration", () => {
  it("only schedules an explicitly validated preview and restarts after scheduling", async () => {
    const { service, ports, order } = fixture();
    await expect(service.restore("unknown", {})).rejects.toThrow("validate");
    expect(ports.restart).not.toHaveBeenCalled();
    await service.preview();
    expect(order).toEqual(["preview"]);
    await service.restore("preview", {});
    expect(order).toEqual(["preview", "seal", "schedule", "restart"]);
    await expect(service.restore("preview", {})).rejects.toThrow("validate");
  });
  it("does not restart on a disk failure", async () => {
    const { service, ports } = fixture();
    ports.schedule = vi.fn(async () => {
      throw new Error("disk locked");
    });
    await service.preview();
    await expect(service.restore("preview", {})).rejects.toThrow("disk locked");
    expect(ports.restart).not.toHaveBeenCalled();
  });
  it("cancels native selection without performing disk work and discards stale previews", async () => {
    const { service, ports } = fixture();
    await service.preview();
    await service.preview();
    expect(ports.discard).toHaveBeenCalledOnce();
    await service.discard("preview");
    await service.discard("preview");
    expect(ports.discard).toHaveBeenCalledTimes(2);
    ports.pickImport = async () => null;
    ports.pickExport = async () => null;
    expect(await service.preview()).toBeNull();
    expect(await service.export({})).toBeNull();
    expect(ports.export).not.toHaveBeenCalled();
  });
  it("prepares a recovery before sealing and leaves the previous environment to the transaction", async () => {
    const { service, ports, order } = fixture();
    expect(await service.receipt()).toBeNull();
    expect((await service.status()).summary.works).toBe(1);
    expect(await service.export({})).toBe("backup.zip");
    await service.recover("old", { "library-sort": "title" });
    expect(order).toEqual(["export", "prepare", "seal", "schedule", "restart"]);
    expect(ports.schedule).toHaveBeenCalledWith("prepared", {
      "library-sort": "title",
    });
  });
});
