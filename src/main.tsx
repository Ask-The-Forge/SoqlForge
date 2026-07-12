import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Surface uncaught promise rejections and runtime errors to devtools so they
// don't silently disappear.
window.addEventListener("error", (e) => {
  // eslint-disable-next-line no-console
  console.error("[window.error]", e.error ?? e.message, e);
});
window.addEventListener("unhandledrejection", (e) => {
  // eslint-disable-next-line no-console
  console.error("[unhandledrejection]", e.reason);
});

// NOTE: StrictMode disabled. It double-mounts every component in dev which was
// observed to cause CodeMirror to leave behind stale event handlers in WebView2
// and freeze the renderer on first interaction. Re-enable once we're confident
// every effect is StrictMode-safe.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
