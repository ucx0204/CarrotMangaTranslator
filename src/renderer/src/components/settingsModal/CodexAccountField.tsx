import React from "react";
import { useTranslation } from "react-i18next";
import type { CodexAccountSnapshot } from "../../../../shared/codexAccountTypes";
import { settingsGateway } from "../../api/settingsGateway";
import { formatSettingsErrorMessage } from "../settingsModalHelpers";

type AccountAction = "login" | "logout";

const CATALOG_REFRESH_INTERVAL_MS = 5 * 60_000;

type AccountRefreshState = { lastReadAt: number | null; revision: number };

type CodexAccountController = {
  snapshot: CodexAccountSnapshot | null;
  loading: boolean;
  action: AccountAction | null;
  error: string | null;
  runAction: (action: AccountAction) => Promise<void>;
};

export function CodexAccountField({
  controlsBusy,
  onSnapshotChange,
}: {
  controlsBusy: boolean;
  onSnapshotChange?: (snapshot: CodexAccountSnapshot | null) => void;
}): React.JSX.Element {
  const controller = useCodexAccountController(controlsBusy, onSnapshotChange);
  const authenticated = controller.snapshot?.authenticated === true;
  const disabled =
    controlsBusy || controller.loading || controller.action !== null;
  return (
    <section
      className="codex-account-card"
      aria-labelledby="codex-account-title"
    >
      <CodexAccountSummary
        snapshot={controller.snapshot}
        loading={controller.loading}
      />
      <CodexAccountActionButton
        authenticated={authenticated}
        action={controller.action}
        disabled={disabled}
        runAction={controller.runAction}
      />
      {controller.error ? (
        <p className="codex-account-error" role="alert">
          {controller.error}
        </p>
      ) : null}
    </section>
  );
}

function CodexAccountSummary({
  snapshot,
  loading,
}: {
  snapshot: CodexAccountSnapshot | null;
  loading: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const authenticated = snapshot?.authenticated === true;
  const status = readAccountStatus(snapshot, loading, {
    loading: t("settings.codex.account.loading"),
    connected: t("settings.codex.account.connected"),
    signedOut: t("settings.codex.account.signedOut"),
  });
  return (
    <div className="codex-account-summary">
      <span
        className={`codex-account-indicator ${authenticated ? "connected" : ""}`}
        aria-hidden="true"
      />
      <div>
        <strong id="codex-account-title">
          {t("settings.codex.account.title")}
        </strong>
        <p aria-live="polite">{status}</p>
        {authenticated && snapshot.planType ? (
          <small>
            {t("settings.codex.account.plan", { plan: snapshot.planType })}
          </small>
        ) : null}
      </div>
    </div>
  );
}

function CodexAccountActionButton({
  authenticated,
  action,
  disabled,
  runAction,
}: {
  authenticated: boolean;
  action: AccountAction | null;
  disabled: boolean;
  runAction: (action: AccountAction) => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const nextAction = authenticated ? "logout" : "login";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void runAction(nextAction)}
    >
      {readActionLabel(action, authenticated, {
        signingIn: t("settings.codex.account.signingIn"),
        signingOut: t("settings.codex.account.signingOut"),
        signIn: t("settings.codex.account.signIn"),
        signOut: t("settings.codex.account.signOut"),
      })}
    </button>
  );
}

function useCodexAccountController(
  controlsBusy: boolean,
  onSnapshotChange?: (snapshot: CodexAccountSnapshot | null) => void,
): CodexAccountController {
  const { t } = useTranslation("components");
  const [snapshot, setSnapshot] = React.useState<CodexAccountSnapshot | null>(
    null,
  );
  const [loading, setLoading] = React.useState(true);
  const [action, setAction] = React.useState<AccountAction | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const refreshState = React.useRef<AccountRefreshState>({
    lastReadAt: null,
    revision: 0,
  });
  const publishSnapshot = React.useCallback(
    (next: CodexAccountSnapshot) => {
      refreshState.current.lastReadAt = Date.now();
      setSnapshot(next);
      onSnapshotChange?.(next);
    },
    [onSnapshotChange],
  );

  useCodexAccountRefresh(
    controlsBusy || action !== null,
    refreshState,
    publishSnapshot,
    setLoading,
    setError,
  );

  const runAction = React.useCallback(
    async (nextAction: AccountAction) => {
      refreshState.current.revision += 1;
      setAction(nextAction);
      setError(null);
      try {
        publishSnapshot(await performAccountAction(nextAction));
      } catch (caught) {
        setError(
          formatSettingsErrorMessage(
            caught,
            t(accountActionFailureKey(nextAction)),
          ),
        );
      } finally {
        setAction(null);
      }
    },
    [publishSnapshot, t],
  );
  return { snapshot, loading, action, error, runAction };
}

function useCodexAccountRefresh(
  paused: boolean,
  refreshState: React.RefObject<AccountRefreshState>,
  publishSnapshot: (snapshot: CodexAccountSnapshot) => void,
  setLoading: React.Dispatch<React.SetStateAction<boolean>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  const { t } = useTranslation("components");
  React.useEffect(() => {
    if (paused) return;
    let active = true;
    let inFlight = false;
    const refresh = () => {
      if (!active || inFlight || document.hidden) return;
      inFlight = true;
      const revision = refreshState.current.revision;
      void settingsGateway
        .getCodexAccount()
        .then((next) => {
          if (!active || revision !== refreshState.current.revision) return;
          setError(null);
          publishSnapshot(next);
        })
        .catch((caught: unknown) => {
          if (!active || revision !== refreshState.current.revision) return;
          setError(
            formatSettingsErrorMessage(
              caught,
              t("settings.codex.account.loadFailed"),
            ),
          );
        })
        .finally(() => {
          inFlight = false;
          if (!active || revision !== refreshState.current.revision) return;
          refreshState.current.lastReadAt = Date.now();
          setLoading(false);
        });
    };
    const refreshWhenStale = () => {
      const lastReadAt = refreshState.current.lastReadAt;
      if (
        lastReadAt === null ||
        Date.now() - lastReadAt >= CATALOG_REFRESH_INTERVAL_MS
      )
        refresh();
    };
    refreshWhenStale();
    const timer = window.setInterval(refresh, CATALOG_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshWhenStale);
    document.addEventListener("visibilitychange", refreshWhenStale);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenStale);
      document.removeEventListener("visibilitychange", refreshWhenStale);
    };
  }, [paused, refreshState, publishSnapshot, setError, setLoading, t]);
}

async function performAccountAction(
  action: AccountAction,
): Promise<CodexAccountSnapshot> {
  return action === "login"
    ? settingsGateway.loginCodexAccount()
    : settingsGateway.logoutCodexAccount();
}

function accountActionFailureKey(action: AccountAction): string {
  return action === "login"
    ? "settings.codex.account.loginFailed"
    : "settings.codex.account.logoutFailed";
}

function readAccountStatus(
  snapshot: CodexAccountSnapshot | null,
  loading: boolean,
  labels: { loading: string; connected: string; signedOut: string },
): string {
  if (loading) return labels.loading;
  if (!snapshot?.authenticated) return labels.signedOut;
  return snapshot.email || labels.connected;
}

function readActionLabel(
  action: AccountAction | null,
  authenticated: boolean,
  labels: {
    signingIn: string;
    signingOut: string;
    signIn: string;
    signOut: string;
  },
): string {
  if (action === "login") return labels.signingIn;
  if (action === "logout") return labels.signingOut;
  return authenticated ? labels.signOut : labels.signIn;
}
