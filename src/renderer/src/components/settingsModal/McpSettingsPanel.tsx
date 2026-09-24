import React from "react";
import { describeMcpScopes } from "../../../../shared/mcpScopeDescriptions";
import type {
  McpDesktopStatus,
  McpDiagnostics,
} from "../../../../shared/mcpDesktopTypes";
import { mcpGateway } from "../../api/mcpGateway";
import { Button } from "../ui/Button";
import { CheckboxField } from "../ui/CheckboxField";
import { SettingsSection } from "./SettingsSection";
import { useMcpSettings } from "./useMcpSettings";
import styles from "./McpSettingsPanel.module.css";

type Props = {
  status: McpDesktopStatus | null;
  error: string | null;
  busy: boolean;
  diagnostics: McpDiagnostics | null;
  run: (action: () => Promise<unknown>) => Promise<void>;
  diagnose: () => Promise<void>;
};
export function McpSettingsPanel(): React.JSX.Element {
  return <McpSettingsView {...useMcpSettings()} />;
}
export function McpSettingsView(props: Props): React.JSX.Element {
  const { status, diagnostics } = props;
  return (
    <div className={styles.stack}>
      <McpServerSection {...props} />
      {status && <McpPermissions {...props} status={status} />}
      {status && <McpConnections {...props} status={status} />}
      {diagnostics && (
        <SettingsSection
          title="연결 진단 결과"
          description="진단 실행 당시의 공개 OAuth 메타데이터와 무인증 MCP POST 거부를 확인합니다. 인증정보·보관함은 보내지 않으며 실제 ChatGPT 로그인이나 도구 실행을 검증하지는 않습니다."
        >
          {diagnostics.checks.map((check) => (
            <p key={check.name}>
              {check.passed ? "PASS" : "FAIL"} · {check.name}: {check.message}
            </p>
          ))}
        </SettingsSection>
      )}
    </div>
  );
}
function McpServerSection({ status, error, busy, run, diagnose }: Props) {
  return (
    <SettingsSection
      title="Tailscale Funnel 연결"
      description="외부 연결은 Tailscale만 사용합니다. 처음 한 번 Tailscale 설치·로그인과 Funnel 허용이 필요합니다."
    >
      <p>
        서버를 꺼도 고정 주소와 승인 기록은 유지됩니다. 앱을 종료하면 당근의
        MCP와 Funnel 연결도 종료됩니다.
      </p>
      <p role="status">
        상태: {status ? stateLabel(status.state) : "확인 중…"}
      </p>
      {status?.message && <p role="status">{status.message}</p>}
      {error && <p role="alert">{error}</p>}
      {status?.url && (
        <p className={styles.address}>
          <code>{status.url}</code>
        </p>
      )}
      <McpServerActions {...{ status, busy, run, diagnose }} />
    </SettingsSection>
  );
}
function McpServerActions({
  status,
  busy,
  run,
  diagnose,
}: Pick<Props, "status" | "busy" | "run" | "diagnose">) {
  const enabled =
    status !== null &&
    ["online", "starting", "stopping"].includes(status.state);
  const urlReady = Boolean(status?.url) && !busy;
  return (
    <div className={styles.actions}>
      <Button
        variant="primary"
        disabled={!status || (busy && !enabled)}
        onClick={() => void run(() => mcpGateway.setMcpEnabled(!enabled))}
      >
        {enabled ? "MCP 끄기" : "MCP 켜기"}
      </Button>
      <Button
        disabled={!urlReady}
        onClick={() => void run(() => mcpGateway.copyMcpUrl())}
      >
        고정 주소 복사
      </Button>
      <Button disabled={!urlReady} onClick={() => void diagnose()}>
        연결 진단
      </Button>
      <Button
        onClick={() => void run(() => mcpGateway.openMcpHelp("tailscale"))}
      >
        Tailscale 설치 안내
      </Button>
      {status?.setupUrl && (
        <Button onClick={() => void run(() => mcpGateway.openMcpHelp("setup"))}>
          Tailscale에서 Funnel 허용
        </Button>
      )}
    </div>
  );
}
function McpPermissions({
  status,
  busy,
  run,
}: Props & { status: McpDesktopStatus }) {
  return (
    <SettingsSection
      title="허용할 기능"
      description="설정은 즉시 적용됩니다. 권한을 바꾸면 진행 중인 MCP 작업을 취소하고 같은 주소로 재시작합니다. 새 권한은 재승인이 필요하며, 자동 실행 설정만 바꾸면 연결은 유지됩니다."
    >
      <div
        className={styles.permissions}
        role="group"
        aria-label="MCP 권한 및 실행 설정"
      >
        <CheckboxField
          className={styles.permission}
          label="이미지와 이미지 포함 출력 파일 전송 허용"
          checked={status.preferences.allowImages}
          disabled={busy}
          onCheckedChange={(allowImages) =>
            void run(() =>
              mcpGateway.configureMcp({ ...status.preferences, allowImages }),
            )
          }
        />
        <CheckboxField
          className={styles.permission}
          label="텍스트·서식·문맥 편집 허용"
          checked={status.preferences.allowEditing}
          disabled={busy}
          onCheckedChange={(allowEditing) =>
            void run(() =>
              mcpGateway.configureMcp({ ...status.preferences, allowEditing }),
            )
          }
        />
        <CheckboxField
          className={styles.permission}
          label="블록·보관함 관리 및 앱 모델 처리 허용"
          checked={status.preferences.allowProcessing === true}
          disabled={busy}
          onCheckedChange={(allowProcessing) =>
            void run(() =>
              mcpGateway.configureMcp({
                ...status.preferences,
                allowProcessing,
              }),
            )
          }
        />
        <CheckboxField
          className={styles.permission}
          label="앱 시작 시 MCP 자동 실행"
          checked={status.preferences.autoStart}
          disabled={busy}
          onCheckedChange={(autoStart) =>
            void run(() =>
              mcpGateway.configureMcp({ ...status.preferences, autoStart }),
            )
          }
        />
      </div>
      <p>
        읽기 권한은 현재 보관함 전체의 텍스트·문맥 조회와 텍스트·문맥 파일
        출력에 적용됩니다. 이미지와 이미지가 포함된 출력 파일은 별도 이미지
        승인이 필요하며 기존 가리기 보호를 지킵니다. 편집·처리 권한을 승인한
        연결은 도구별 대상과 권한 확인에 따라 텍스트·서식·문맥과 블록·보관함
        구조를 변경할 수 있습니다.
      </p>
      <p>
        처리 권한은 명시적으로 요청한 OCR·번역·원문 제거·이미지 작업을 앱에
        설정된 엔진으로 실행할 수 있게 합니다. 외부 제공자를 사용하는 작업은
        필요한 텍스트나 이미지를 전송하며 요금이 발생할 수 있습니다. 연결
        승인만으로 작업을 시작하지는 않습니다.
      </p>
    </SettingsSection>
  );
}
function McpConnections({
  status,
  busy,
  run,
}: Props & { status: McpDesktopStatus }) {
  return (
    <SettingsSection
      title="AI 연결 승인"
      description="ChatGPT에 고정 주소를 OAuth 방식으로 등록하세요. Client ID·Client Secret은 비워 둡니다. 연결 암호를 복사할 필요가 없습니다."
    >
      <div className={styles.actions}>
        <Button
          onClick={() => void run(() => mcpGateway.openMcpHelp("chatgpt"))}
        >
          ChatGPT 열기
        </Button>
      </div>
      <p role="status">
        {status.state === "online"
          ? "MCP가 켜져 있는 동안 새 연결 요청을 항상 받습니다. 브라우저와 아래 숫자 코드가 같은 요청만 앱에서 승인하세요. 승인 전에는 접근 권한이 없습니다."
          : "MCP를 켜면 새 연결 요청을 받습니다. 숫자 코드를 확인하고 앱에서 승인해야 연결됩니다."}
      </p>
      {status.pending.map((request) => (
        <div key={request.id} className={styles.connection}>
          <strong>확인 코드: {request.code}</strong>
          <p>클라이언트가 표시한 이름: {request.clientName}</p>
          <p>요청 권한: {describeMcpScopes(request.scope)}</p>
          <div className={styles.actions}>
            <Button
              disabled={busy}
              onClick={() =>
                void run(() => mcpGateway.resolveMcpPairing(request.id, true))
              }
            >
              같은 코드 확인 · 승인
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(() => mcpGateway.resolveMcpPairing(request.id, false))
              }
            >
              거절
            </Button>
          </div>
        </div>
      ))}
      {status.connections.length === 0 && <p>승인된 연결이 없습니다.</p>}
      {status.connections.map((connection) => (
        <div key={connection.id} className={styles.connection}>
          <strong>{connection.clientName}</strong>
          <p>
            {describeMcpScopes(connection.scope)} ·{" "}
            {connection.revoked ? "철회됨" : "승인 유지 중"}
          </p>
          <Button
            variant="danger"
            disabled={busy || connection.revoked}
            onClick={() =>
              void run(() => mcpGateway.revokeMcpConnection(connection.id))
            }
          >
            연결 권한 철회
          </Button>
        </div>
      ))}
    </SettingsSection>
  );
}
function stateLabel(state: McpDesktopStatus["state"]) {
  return {
    off: "꺼짐",
    starting: "연결 준비 중",
    online: "연결 가능",
    stopping: "종료 중",
    error: "연결 확인 필요",
  }[state];
}
