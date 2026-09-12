import { setTimeout as delay } from "node:timers/promises";
import {
  assertTailscaleListenerFree,
  readTailscaleOrigin,
  readTailscaleSetupUrl,
  tailscaleRouteReady,
} from "./mcpTailscalePolicy";
import {
  findTailscaleBinary,
  spawnTailscale,
  tailscaleJson,
} from "./mcpTailscaleProcess";

export class McpTailscaleSetupError extends Error {
  constructor(readonly setupUrl: string) {
    super("Tailscale 웹 설정에서 Funnel과 HTTPS를 허용한 후 다시 켜세요.");
  }
}
export async function prepareTailscale() {
  const binary = await findTailscaleBinary();
  const origin = readTailscaleOrigin(
    await tailscaleJson(binary, ["status", "--json"]),
  );
  assertTailscaleListenerFree(
    await tailscaleJson(binary, ["serve", "status", "--json"]),
  );
  return { binary, origin };
}
export async function openTailscale(
  target: { binary: string; origin: string },
  port: number,
  signal: AbortSignal,
  onFailure: () => void,
) {
  signal.throwIfAborted();
  const child = spawnTailscale(target.binary, port);
  try {
    await waitForRoute(child, target, port, signal);
    child.onUnexpectedExit(onFailure);
    return child;
  } catch (error) {
    try {
      await child.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Funnel start and cleanup failed.",
        { cause: cleanup },
      );
    }
    throw error;
  }
}
async function waitForRoute(
  child: ReturnType<typeof spawnTailscale>,
  target: { binary: string; origin: string },
  port: number,
  signal: AbortSignal,
): Promise<void> {
  // Bounded readiness polling, not retries of user work or side-effectful commands.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const setup = readTailscaleSetupUrl(child.output());
    if (setup) throw new McpTailscaleSetupError(setup);
    child.assertAlive();
    const status = await tailscaleJson(target.binary, [
      "serve",
      "status",
      "--json",
    ]);
    if (tailscaleRouteReady(status, target.origin, port)) return;
    await delay(500, undefined, { signal });
  }
  throw new Error("Tailscale Funnel 준비 확인 시간이 초과되었습니다.");
}
