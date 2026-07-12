import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PanelWindowApp } from "./panels/PanelWindowApp";
import { parsePanelRoute } from "./panels/panelRoute";
import { uiLocaleGateway } from "./api/uiLocaleGateway";
import { initializeAppI18n } from "./appI18n";
import { AppI18nProvider } from "./i18n";
import { DEFAULT_UI_LOCALE, normalizeUiLocale } from "../../shared/uiLocales";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found.");
}

async function bootstrapRenderer(root: HTMLElement): Promise<void> {
  let locale = DEFAULT_UI_LOCALE;
  try {
    locale = normalizeUiLocale(
      await uiLocaleGateway.getUiLocale(),
      DEFAULT_UI_LOCALE,
    );
  } catch (error) {
    console.error("Failed to load UI locale; using Korean fallback.", error);
  }
  await initializeAppI18n(locale);
  const panelId = parsePanelRoute(window.location.hash);
  createRoot(root).render(
    <React.StrictMode>
      <AppI18nProvider>
        <ErrorBoundary>
          {panelId ? <PanelWindowApp panelId={panelId} /> : <App />}
        </ErrorBoundary>
      </AppI18nProvider>
    </React.StrictMode>,
  );
}

void bootstrapRenderer(rootElement);
