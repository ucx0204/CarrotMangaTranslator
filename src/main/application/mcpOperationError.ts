/** Fixed, public-safe explanations. Never wrap or expose raw storage/OS error messages. */
export class McpOperationError extends Error {
  constructor(
    readonly code:
      | "PAGE_CHANGED"
      | "BLOCK_NOT_FOUND"
      | "APP_BUSY"
      | "ACCESS_REVOKED",
    message: string,
  ) {
    super(message);
  }
}
