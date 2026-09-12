import React from "react";
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
          description="인증정보나 보관함을 외부로 보내지 않고 주소와 접근 차단을 확인합니다. 실제 ChatGPT 로그인을 대신하지는 않습니다."
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
      description="설정은 즉시 적용됩니다. 켜진 서버의 권한 설정을 바꾸면 같은 주소로 재시작합니다. 기존 승인은 보존되지만 새 권한은 재승인이 필요합니다."
    >
      <CheckboxField
        label="원본 페이지 이미지 전송 허용"
        checked={status.preferences.allowImages}
        disabled={busy}
        onCheckedChange={(allowImages) =>
          void run(() =>
            mcpGateway.configureMcp({ ...status.preferences, allowImages }),
          )
        }
      />
      <CheckboxField
        label="기존 블록의 번역문 수정 허용"
        checked={status.preferences.allowEditing}
        disabled={busy}
        onCheckedChange={(allowEditing) =>
          void run(() =>
            mcpGateway.configureMcp({ ...status.preferences, allowEditing }),
          )
        }
      />
      <CheckboxField
        label="앱 시작 시 MCP 자동 실행"
        checked={status.preferences.autoStart}
        disabled={busy}
        onCheckedChange={(autoStart) =>
          void run(() =>
            mcpGateway.configureMcp({ ...status.preferences, autoStart }),
          )
        }
      />
      <p>
        읽기 권한은 현재 보관함 전체에 적용됩니다. 이미지 전송은 별도 승인이
        필요하며 기존 가리기 보호를 우회하지 않습니다. 편집을 허용하면 기존
        블록의 번역문만 수정하며 위치·서식·마스크를 보존합니다. 앱의 OCR·번역
        엔진 실행과 새 블록 생성은 아직 제공하지 않습니다.
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
          disabled={status.state !== "online" || busy}
          onClick={() => void run(() => mcpGateway.beginMcpPairing())}
        >
          새 연결 허용 · 5분
        </Button>
        <Button
          onClick={() => void run(() => mcpGateway.openMcpHelp("chatgpt"))}
        >
          ChatGPT 열기
        </Button>
      </div>
      {status.pairingUntil && (
        <p>
          새 연결 요청을 받고 있습니다. 브라우저와 아래 확인 코드가 같은 요청만
          승인하세요.
        </p>
      )}
      {status.pending.map((request) => (
        <div key={request.id} className={styles.connection}>
          <strong>확인 코드: {request.code}</strong>
          <p>클라이언트가 표시한 이름: {request.clientName}</p>
          <p>요청 권한: {request.scope}</p>
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
            {connection.scope} ·{" "}
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
