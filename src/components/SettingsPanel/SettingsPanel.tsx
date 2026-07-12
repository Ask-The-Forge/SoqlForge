/**
 * SettingsPanel — overlay drawer for CLI path override, timeout, font size.
 *
 * Settings live in two places:
 *   - CLI path & timeout → Rust backend (set_cli_settings) — affects subprocess spawning
 *   - Theme & font size → Zustand store (persisted to localStorage)
 *
 * Backend settings are fetched on open so we always show the live value.
 */

import { useEffect, useState } from "react";
import {
  type AiSettings,
  type CliSettings,
  getAiSettings,
  getCliSettings,
  setAiSettings,
  setCliSettings,
  toAppError,
} from "../../lib/tauriClient";
import { useAppStore } from "../../stores/appStore";
import { AskTheForgeLink } from "../shared/AskTheForge";

type AiProvider = "claude" | "gemini" | "openai";

const PROVIDER_LABELS: Record<AiProvider, string> = {
  claude: "Anthropic Claude",
  gemini: "Google Gemini",
  openai: "OpenAI",
};

const PROVIDER_HINTS: Record<AiProvider, string> = {
  claude: "Get a key at console.anthropic.com → API Keys.",
  gemini: "Get a key at aistudio.google.com → Get API key.",
  openai: "Get a key at platform.openai.com → API keys.",
};

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const fontSize = useAppStore((s) => s.fontSize);
  const setFontSize = useAppStore((s) => s.setFontSize);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const clearHistory = useAppStore((s) => s.clearHistory);

  const [cli, setCli] = useState<CliSettings>({
    pathOverride: "",
    timeoutSecs: 30,
  });
  const [ai, setAi] = useState<AiSettings>({
    provider: null,
    apiKey: null,
    model: null,
  });
  const [showAiKey, setShowAiKey] = useState(false);
  const [aiSavedFlash, setAiSavedFlash] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setAiError(null);
    setLoaded(false);
    Promise.all([getCliSettings(), getAiSettings()])
      .then(([cliS, aiS]) => {
        setCli({
          pathOverride: cliS.pathOverride ?? "",
          timeoutSecs: cliS.timeoutSecs,
        });
        setAi({
          provider: aiS.provider ?? null,
          apiKey: aiS.apiKey ?? null,
          model: aiS.model ?? null,
        });
        setLoaded(true);
      })
      .catch((e) => {
        setError(toAppError(e).message);
        setLoaded(true);
      });
  }, [open]);

  if (!open) return null;

  const handleSave = async () => {
    setError(null);
    try {
      await setCliSettings({
        pathOverride: cli.pathOverride?.trim() || null,
        timeoutSecs: cli.timeoutSecs,
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1200);
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const handleSaveAi = async () => {
    setAiError(null);
    try {
      await setAiSettings({
        provider: ai.provider?.trim() || null,
        apiKey: ai.apiKey?.trim() || null,
        model: ai.model?.trim() || null,
      });
      setAiSavedFlash(true);
      setTimeout(() => setAiSavedFlash(false), 1200);
    } catch (e) {
      setAiError(toAppError(e).message);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex justify-end"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-96 max-w-full h-full bg-zinc-950 border-l border-zinc-800 flex flex-col"
      >
        <div className="flex items-center px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-100">Settings</h2>
          <button
            onClick={onClose}
            className="ml-auto text-zinc-400 hover:text-zinc-100 text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5 text-sm">
          <section className="flex flex-col gap-2">
            <h3 className="text-xs uppercase text-zinc-500 tracking-wide">
              Salesforce CLI
            </h3>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-300">Path override</span>
              <input
                type="text"
                placeholder="(auto-detect from PATH)"
                value={cli.pathOverride ?? ""}
                onChange={(e) =>
                  setCli((p) => ({ ...p, pathOverride: e.target.value }))
                }
                disabled={!loaded}
                className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-100 font-mono text-xs"
              />
              <span className="text-xs text-zinc-500">
                Leave blank to use the <code>sf</code> on your PATH.
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-300">Query timeout (seconds)</span>
              <input
                type="number"
                min={5}
                max={600}
                value={cli.timeoutSecs}
                onChange={(e) =>
                  setCli((p) => ({
                    ...p,
                    timeoutSecs: Number(e.target.value) || 30,
                  }))
                }
                disabled={!loaded}
                className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-100 w-24"
              />
            </label>
            <div className="flex items-center gap-2 mt-1">
              <button
                onClick={() => void handleSave()}
                disabled={!loaded}
                className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs disabled:opacity-50"
              >
                Save CLI settings
              </button>
              {savedFlash && (
                <span className="text-emerald-400 text-xs">Saved ✓</span>
              )}
            </div>
            {error && (
              <div className="text-red-400 text-xs mt-1">{error}</div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs uppercase text-zinc-500 tracking-wide">
              AI Assist
            </h3>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-300">Provider</span>
              <select
                value={ai.provider ?? ""}
                onChange={(e) =>
                  setAi((p) => ({ ...p, provider: e.target.value || null }))
                }
                disabled={!loaded}
                className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-100 text-xs"
              >
                <option value="">(off — AI assist disabled)</option>
                {(Object.keys(PROVIDER_LABELS) as AiProvider[]).map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
            {ai.provider && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-zinc-300">API key</span>
                  <div className="flex gap-1">
                    <input
                      type={showAiKey ? "text" : "password"}
                      value={ai.apiKey ?? ""}
                      onChange={(e) =>
                        setAi((p) => ({ ...p, apiKey: e.target.value || null }))
                      }
                      placeholder="paste your API key"
                      disabled={!loaded}
                      autoComplete="off"
                      spellCheck={false}
                      className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-100 font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAiKey((s) => !s)}
                      className="text-xs text-zinc-400 hover:text-zinc-100 px-2 border border-zinc-700 rounded"
                      title={showAiKey ? "Hide key" : "Show key"}
                    >
                      {showAiKey ? "Hide" : "Show"}
                    </button>
                  </div>
                  <span className="text-xs text-zinc-500">
                    {PROVIDER_HINTS[ai.provider as AiProvider] ??
                      "Key is sent only to the provider you selected."}
                  </span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-zinc-300">Model (optional)</span>
                  <input
                    type="text"
                    value={ai.model ?? ""}
                    onChange={(e) =>
                      setAi((p) => ({ ...p, model: e.target.value || null }))
                    }
                    placeholder="(provider default)"
                    disabled={!loaded}
                    className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-100 font-mono text-xs"
                  />
                </label>
              </>
            )}
            <div className="flex items-center gap-2 mt-1">
              <button
                onClick={() => void handleSaveAi()}
                disabled={!loaded}
                className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs disabled:opacity-50"
              >
                Save AI settings
              </button>
              {aiSavedFlash && (
                <span className="text-emerald-400 text-xs">Saved ✓</span>
              )}
            </div>
            {aiError && <div className="text-red-400 text-xs mt-1">{aiError}</div>}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs uppercase text-zinc-500 tracking-wide">
              Appearance
            </h3>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-300">Editor font size</span>
              <input
                type="number"
                min={10}
                max={24}
                value={fontSize}
                onChange={(e) =>
                  setFontSize(
                    Math.max(10, Math.min(24, Number(e.target.value) || 14)),
                  )
                }
                className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-100 w-24"
              />
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-zinc-300">Theme</span>
              <div className="inline-flex rounded border border-zinc-700 overflow-hidden self-start text-xs">
                <button
                  onClick={() => setTheme("dark")}
                  className={
                    "px-3 py-1 " +
                    (theme === "dark"
                      ? "bg-blue-600 text-white"
                      : "text-zinc-300 hover:bg-zinc-800")
                  }
                  aria-pressed={theme === "dark"}
                >
                  Dark
                </button>
                <button
                  onClick={() => setTheme("light")}
                  className={
                    "px-3 py-1 border-l border-zinc-700 " +
                    (theme === "light"
                      ? "bg-blue-600 text-white"
                      : "text-zinc-300 hover:bg-zinc-800")
                  }
                  aria-pressed={theme === "light"}
                >
                  Light
                </button>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs uppercase text-zinc-500 tracking-wide">
              History
            </h3>
            <button
              onClick={() => clearHistory()}
              className="self-start text-xs text-red-300 hover:text-red-200 border border-red-900/50 rounded px-2 py-1"
            >
              Clear query history
            </button>
          </section>

          <section className="flex flex-col gap-2 mt-auto pt-4 border-t border-zinc-800">
            <h3 className="text-xs uppercase text-zinc-500 tracking-wide">
              About
            </h3>
            <p className="text-xs text-zinc-500">
              SoqlForge is a free, open-source project from{" "}
              <AskTheForgeLink className="text-amber-400 hover:text-amber-300 underline underline-offset-2" />
              . Provided as-is, with no warranty.
            </p>
            <AskTheForgeLink className="self-start text-xs text-amber-400 hover:text-amber-300 border border-amber-500/30 rounded px-2 py-1">
              ⚒ Visit asktheforge.com
            </AskTheForgeLink>
          </section>
        </div>
      </div>
    </div>
  );
}
