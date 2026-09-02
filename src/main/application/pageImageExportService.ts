import type {
  PageExportSelectionRequest,
  PageImageExportPreflightResult,
  PageImageExportRequest,
  PageImageExportResult,
  PagePsdExportRequest,
} from "../../shared/pageImageExportTypes";

export type PageImageExportExecutionPort = {
  assertIdle: () => void;
  preflight: (
    request: PageExportSelectionRequest,
  ) => Promise<PageImageExportPreflightResult>;
  exportImages: (
    request: PageImageExportRequest,
    outputParentDir: string,
  ) => Promise<PageImageExportResult>;
  exportPsd: (
    request: PagePsdExportRequest,
    outputParentDir: string,
  ) => Promise<PageImageExportResult>;
};

export type PageImageExportDestinationPort = {
  pick: () => Promise<string | null>;
  remember: (directory: string) => void;
};

export class PageImageExportApplicationService {
  constructor(
    private readonly execution: PageImageExportExecutionPort,
    private readonly destinations: PageImageExportDestinationPort,
  ) {}

  preflight(
    request: PageExportSelectionRequest,
  ): Promise<PageImageExportPreflightResult> {
    return this.execution.preflight({
      ...request,
      expectedTargets: undefined,
    });
  }

  exportImages(
    request: PageImageExportRequest,
  ): Promise<PageImageExportResult | null> {
    return this.exportWithDestination((outputParentDir) =>
      this.execution.exportImages(request, outputParentDir),
    );
  }

  exportPsd(
    request: PagePsdExportRequest,
  ): Promise<PageImageExportResult | null> {
    return this.exportWithDestination((outputParentDir) =>
      this.execution.exportPsd(request, outputParentDir),
    );
  }

  private async exportWithDestination(
    execute: (outputParentDir: string) => Promise<PageImageExportResult>,
  ): Promise<PageImageExportResult | null> {
    this.execution.assertIdle();
    const outputParentDir = await this.destinations.pick();
    if (!outputParentDir) return null;

    const result = await execute(outputParentDir);
    if (result.status === "completed") {
      this.destinations.remember(outputParentDir);
    }
    return result;
  }
}
