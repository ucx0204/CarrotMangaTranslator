import type { MangaPage } from "../../shared/libraryTypes";

/** A stage may commit its successful regions while leaving the stage retryable. */
export class PageWorkflowPartialFailure extends Error {
  constructor(
    message: string,
    readonly page: MangaPage,
  ) {
    super(message);
    this.name = "PageWorkflowPartialFailure";
  }
}
