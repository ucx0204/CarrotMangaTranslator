import { JsonLinesWorkerClient } from "../runtimeSupport/jsonLinesWorkerClient";
import {
  QwenGpuBudget,
  qwenWorkerEnvironment,
  type QwenGpuStatus,
} from "./qwenGpuBudget";

type Budget = Pick<QwenGpuBudget, "wait" | "monitor">;
export type QwenSessionLaunch = {
  executable: string;
  env: NodeJS.ProcessEnv;
  gpuUuid?: string;
  platformGpu?: Budget;
  status?: (status: QwenGpuStatus) => void;
  nativeScript?: string;
  workerName?: string;
};
const memoryFailure =
  /cannot make enough memory available|out of memory|insufficient memory/i;

/** One guarded process per erasure lease. The watcher also covers the gaps
 * between crops, when a private inference job can claim the GPU. */
export class QwenControlSession {
  private active?: ReturnType<QwenControlSession["start"]>;

  private readonly budget: Budget;
  constructor(private readonly launch: QwenSessionLaunch) {
    const budget =
      launch.platformGpu ??
      (launch.gpuUuid &&
        new QwenGpuBudget(launch.gpuUuid, launch.env.CARROT_QWEN_KOFFI));
    if (!budget) throw new Error("Qwen GPU 장치가 지정되지 않았습니다.");
    this.budget = budget;
  }

  private start(args: string[]) {
    const client = new JsonLinesWorkerClient<{ config: string }>({
      executable: this.launch.executable,
      args: this.launch.nativeScript
        ? [this.launch.nativeScript]
        : [...args.slice(0, -1), "--session"],
      env: qwenWorkerEnvironment(this.launch.env, this.launch.gpuUuid),
      workerName: this.launch.workerName ?? "Qwen Image 2.1",
      // PyTorch and the native backend can take several seconds to destroy
      // their resident contexts after the last crop. An active abort still
      // follows the client's immediate process-tree termination path.
      shutdownTimeoutMs: 10_000,
      buildExitError: (code, stderr) =>
        new Error(`Qwen Image 2.1 (${code}): ${stderr}`),
      buildNotRunningError: (stderr) => new Error(`Qwen Image 2.1: ${stderr}`),
      sanitizeStderr: (text) => text,
      onStderr: () => {},
      onTerminationError: (error) => console.error(error),
    });
    const watch = client.pid
      ? this.budget.monitor(client.pid, client.exited, () => {
          void client.dispose().catch((error: unknown) => console.error(error));
        })
      : Promise.resolve("ready" as const);
    // A failed probe releases the device just as preemption does. A new
    // process must pass the launch budget before resuming at the same size.
    const guarded = watch.catch(async (error: unknown) => {
      console.warn("Qwen GPU monitor", error);
      await client.dispose();
      return "telemetry" as const;
    });
    void guarded.catch((error: unknown) =>
      console.error("Qwen shutdown", error),
    );
    return { client, watch: guarded };
  }

  async run(args: string[], signal: AbortSignal): Promise<QwenGpuStatus> {
    if (!this.active?.client.isHealthy()) {
      await this.dispose();
      await this.budget.wait(signal, this.launch.status);
      signal.throwIfAborted();
      this.active = this.start(args);
    }
    const { client, watch } = this.active;
    try {
      const { response } = client.startRequest(
        { config: args[args.length - 1] },
        signal,
      );
      const result = await response;
      if (!result.ok)
        throw new Error(result.error || "Qwen Image 2.1 추론 실패");
      return "ready";
    } catch (error) {
      this.active = undefined;
      await client.dispose();
      const status = await watch;
      signal.throwIfAborted();
      if (status !== "ready") return status;
      if (memoryFailure.test(String(error))) return "memory";
      throw error;
    }
  }

  async dispose() {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    await active.client.dispose();
    await active.watch;
  }
}
