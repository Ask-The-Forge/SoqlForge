/**
 * AiPromptBar — inline NL→SOQL prompt input that sits between the editor
 * toolbar and the editor itself.
 *
 * UX:
 *   - Press the ✨ AI button in QueryEditor to toggle this open
 *   - Type a natural-language description ("opps closed last quarter")
 *   - Hit Generate (or Enter) → the AI replaces the editor's text with the
 *     generated SOQL
 *   - Esc closes the bar without changing anything
 *
 * If the user hasn't configured an API key yet, the bar shows a Settings
 * shortcut instead of an input.
 */

import { useEffect, useRef, useState } from "react";
import {
  aiGenerateSoql,
  getAiSettings,
  toAppError,
  type AiSettings,
} from "../../lib/tauriClient";
import { getCurrentFields, getCurrentObject } from "../../lib/schemaCache";

interface AiPromptBarProps {
  open: boolean;
  onClose: () => void;
  /** Called with the generated SOQL. Caller decides whether to replace the
   *  editor content or merge it in. */
  onGenerate: (soql: string) => void;
  /** Called when the user wants to open Settings (no AI key configured). */
  onOpenSettings: () => void;
}

function buildSchemaContext(): string | null {
  const obj = getCurrentObject();
  if (!obj) return null;
  const fields = getCurrentFields();
  if (fields.length === 0) {
    return `Currently selected SObject: ${obj}`;
  }
  // Cap field list so the prompt doesn't balloon for objects with 500+ fields.
  const sample = fields.slice(0, 200).map((f) => `${f.name} (${f.fieldType})`);
  return `Currently selected SObject: ${obj}\nKnown fields (subset): ${sample.join(", ")}`;
}

export function AiPromptBar({
  open,
  onClose,
  onGenerate,
  onOpenSettings,
}: AiPromptBarProps) {
  const [prompt, setPrompt] = useState("");
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [aiLoaded, setAiLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelUsed, setModelUsed] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refresh AI settings each time the bar opens — the user may have just
  // saved a new key.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setModelUsed(null);
    getAiSettings()
      .then((s) => {
        setAi(s);
        setAiLoaded(true);
      })
      .catch(() => setAiLoaded(true));
    // Focus the input on open.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  if (!open) return null;

  const hasKey = !!(ai?.provider && ai.apiKey);

  const handleGenerate = async () => {
    if (!ai?.provider || !ai?.apiKey) return;
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setModelUsed(null);
    try {
      const res = await aiGenerateSoql({
        provider: ai.provider,
        apiKey: ai.apiKey,
        model: ai.model ?? null,
        prompt: trimmed,
        schemaContext: buildSchemaContext(),
      });
      onGenerate(res.soql);
      setModelUsed(res.model);
      setPrompt("");
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 px-3 py-2 bg-blue-950/30 border-b border-blue-900/40">
      {!aiLoaded ? (
        <div className="text-xs text-zinc-500">Loading AI settings…</div>
      ) : !hasKey ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-zinc-300">
            Set an API key in Settings to enable AI assist.
          </span>
          <button
            onClick={onOpenSettings}
            className="text-blue-400 hover:text-blue-300 underline"
          >
            Open Settings
          </button>
          <button
            onClick={onClose}
            className="ml-auto text-zinc-500 hover:text-zinc-200"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400 whitespace-nowrap">
              ✨ {ai?.provider}
            </span>
            <input
              ref={inputRef}
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleGenerate();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
              placeholder="describe the query you want (e.g. opportunities closed last quarter over $50k)"
              disabled={busy}
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-100 text-xs placeholder:text-zinc-600"
            />
            <button
              onClick={() => void handleGenerate()}
              disabled={busy || !prompt.trim()}
              className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium"
            >
              {busy ? "Generating…" : "Generate"}
            </button>
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-200 px-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          {modelUsed && !error && !busy && (
            <div className="text-[10px] text-zinc-500">
              Replaced editor with output from {modelUsed}. Esc to close.
            </div>
          )}
          {error && (
            <div className="text-xs text-red-300 font-mono break-words">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
