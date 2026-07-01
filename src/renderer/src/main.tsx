import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PanelWindowApp } from "./panels/PanelWindowApp";
import { parsePanelRoute } from "./panels/panelRoute";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found.");
}

const panelId = parsePanelRoute(window.location.hash);

createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {panelId ? <PanelWindowApp panelId={panelId} /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
