const SIGN_IN_MESSAGE =
  "Codex 로그인이 만료되었거나 취소되었습니다. 설정 > AI에서 ChatGPT로 다시 로그인해 주세요.";

/** App Server can report revoked credentials without an HTTP status. */
export function normalizeCodexAuthenticationError(error: Error): Error {
  const message = error.message;
  if (
    !/refresh token (?:was revoked|has already been used|has expired)|access token could not be refreshed|refresh_token_(?:revoked|reused|expired)|authentication token (?:is|has) expired/i.test(
      message,
    )
  )
    return error;
  return Object.assign(new Error(SIGN_IN_MESSAGE, { cause: error }), {
    httpStatus: 401,
    status: 401,
    nonRetriable: true,
    failureCategory: "model-request",
    upstreamError: {
      type: "codex_authentication_required",
      message: SIGN_IN_MESSAGE,
    },
  });
}

export function isCodexAuthenticationError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    "upstreamError" in error &&
    (error.upstreamError as { type?: string })?.type ===
      "codex_authentication_required"
  );
}
