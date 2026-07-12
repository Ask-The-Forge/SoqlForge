/**
 * "Ask the Forge" promo link. Opens the company site in the user's default
 * browser via the opener plugin (never in-app). The URL lives here only.
 */

import { openUrl } from "@tauri-apps/plugin-opener";

export const FORGE_URL = "https://asktheforge.com";

/** Open asktheforge.com in the default browser. */
export function openAskTheForge(): void {
  void openUrl(FORGE_URL);
}

/**
 * A text button styled to read as a link. Pass `className` to control color /
 * sizing so it can sit in the compact status bar or the settings drawer.
 */
export function AskTheForgeLink({
  className = "",
  children = "Ask the Forge",
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={openAskTheForge}
      title="Visit asktheforge.com"
      className={className}
    >
      {children}
    </button>
  );
}
