/**
 * Platform detection for UI affordances.
 *
 * Only ever used for *labels* — the key handlers themselves accept both
 * modifiers (`e.ctrlKey || e.metaKey`, and matching `Ctrl-`/`Cmd-` entries in
 * the CodeMirror keymap), so a wrong guess here mislabels a shortcut but never
 * breaks one.
 */

/** True when running on macOS (including the WKWebView Tauri uses there). */
export const isMac: boolean =
  typeof navigator !== "undefined" &&
  /mac/i.test(
    // userAgentData is Chromium-only; WebKit falls back to the UA string.
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ??
      navigator.platform ??
      navigator.userAgent,
  );

/** "⌘" on macOS, "Ctrl" elsewhere. */
export const modKey = isMac ? "⌘" : "Ctrl";

/** Renders a shortcut the way the host platform writes it: `⌘Enter` / `Ctrl+Enter`. */
export function shortcut(key: string): string {
  return isMac ? `${modKey}${key}` : `${modKey}+${key}`;
}
