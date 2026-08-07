import { createServer, type Server } from "node:net";
import { createAbortError, throwIfAborted } from "../abortSignal";
import { tMain } from "./localization";

type ResolvePort = (port: number) => void;
type RejectPort = (error: unknown) => void;

export async function reserveFreePort(signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  return await new Promise<number>((resolve, reject) => {
    new FreePortReservation(createServer(), signal, resolve, reject).start();
  });
}

class FreePortReservation {
  private settled = false;
  private abortReason: Error | null = null;

  constructor(
    private readonly server: Server,
    private readonly signal: AbortSignal | undefined,
    private readonly resolve: ResolvePort,
    private readonly reject: RejectPort,
  ) {}

  start(): void {
    this.server.once("error", this.onError);
    this.server.once("listening", this.onListening);
    this.signal?.addEventListener("abort", this.onAbort, { once: true });
    try {
      this.server.listen(0, "127.0.0.1");
    } catch (error) {
      this.finishReject(this.abortReason ?? error);
    }
  }

  private readonly onAbort = (): void => {
    if (this.settled) {
      return;
    }
    this.abortReason =
      this.signal?.reason instanceof Error
        ? this.signal.reason
        : createAbortError();
    if (this.server.listening) {
      this.closeForAbort();
    }
  };

  private readonly onError = (error: Error): void => {
    this.finishReject(this.abortReason ?? error);
  };

  private readonly onListening = (): void => {
    if (this.abortReason) {
      this.closeForAbort();
      return;
    }
    const address = this.server.address();
    if (!address || typeof address === "string") {
      this.closeThen((error) => {
        this.finishReject(
          error ?? new Error(tMain("modelTest.portUnavailable")),
        );
      });
      return;
    }
    this.closeThen((error) => {
      if (this.abortReason) {
        this.finishReject(this.abortReason);
      } else if (error) {
        this.finishReject(error);
      } else {
        this.finishResolve(address.port);
      }
    });
  };

  private closeForAbort(): void {
    this.closeThen((error) => {
      this.finishReject(this.abortReason ?? error ?? createAbortError());
    });
  }

  private closeThen(callback: (error: Error | null) => void): void {
    try {
      this.server.close((error) => callback(error ?? null));
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private finishResolve(port: number): void {
    this.finish(() => this.resolve(port));
  }

  private finishReject(error: unknown): void {
    this.finish(() => this.reject(error));
  }

  private finish(callback: () => void): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.server.removeListener("error", this.onError);
    this.server.removeListener("listening", this.onListening);
    callback();
  }
}
