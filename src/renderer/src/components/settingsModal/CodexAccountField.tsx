import React from "react";
import { useTranslation } from "react-i18next";
import type { CodexAccountSnapshot } from "../../../../shared/codexAccountTypes";
import { settingsGateway } from "../../api/settingsGateway";
import { formatSettingsErrorMessage } from "../settingsModalHelpers";

type AccountAction = "login" | "logout";

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
  const controller = useCodexAccountController(onSnapshotChange);
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
  onSnapshotChange?: (snapshot: CodexAccountSnapshot | null) => void,
): CodexAccountController {
  const { t } = useTranslation("components");
  const [snapshot, setSnapshot] = React.useState<CodexAccountSnapshot | null>(
    null,
  );
  const [loading, setLoading] = React.useState(true);
  const [action, setAction] = React.useState<AccountAction | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const publishSnapshot = React.useCallback(
    (next: CodexAccountSnapshot) => {
      setSnapshot(next);
      onSnapshotChange?.(next);
    },
    [onSnapshotChange],
  );

  React.useEffect(() => {
    let active = true;
    void settingsGateway
      .getCodexAccount()
      .then((next) => {
        if (active) publishSnapshot(next);
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(
            formatSettingsErrorMessage(
              caught,
              t("settings.codex.account.loadFailed"),
            ),
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [publishSnapshot, t]);

  const runAction = React.useCallback(
    async (nextAction: AccountAction) => {
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
