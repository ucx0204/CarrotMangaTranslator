# MCP file-link default checkpoint — 2026-09-18

Status: source changes saved; NOT built, deployed or verified by automated tests.

The user reproduced a ChatGPT attachment-creation approval for completed export
job `3b0634fd-67fc-4e3b-ac8e-2b716b10c89d`, despite the app's Allow all actions setting.
The existing file tool was already read-only but always returned a resource_link.

The proposed alternative deliberately does NOT create a ChatGPT attachment:

- carrot_get_job_file now defaults to text/metadata containing the expiring link.
- includeAttachment=true explicitly requests the existing resource_link response.
- Both modes retain scope, ownership, availability, revision and redaction checks.
- No automatic downloading, approval bypass or changes to authentication were added.

Updated files: src/main/mcp/mcpOperationTools.ts, tests/mcpJobFile.test.ts,
tests/mcpOperationHttp.test.ts, scripts/mcp-native-page.cjs.
Backups: .tmp/mcp-file-link-default-20260918-062533/ (original files).

The remote request to run Prettier and focused tests was blocked by OpenAI with
"요청의 보안 상태를 결정하지 못해 이 도구 요청은 OpenAI에 의해 차단되었습니다."
That blocked execution was not retried via another route. No test pass is claimed.
The saved source was read back. Build and live app restart were not performed.
Do not claim the current connection uses this change or that the approval is gone.
Remaining: authorized formatting/tests, build, safe normal restart, live link-only check.
