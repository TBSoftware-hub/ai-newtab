import { useState } from "react";
import { OPENROUTER_MODEL_CHOICES, validateOpenRouterModel, type HomepageProvider } from "@homepage/agent-core";
import { type ConnectionSettings } from "@/lib/storage";
import { btn, errorBox } from "./ui";

export function ApiKeySetup({ initial, onSave, compact = false }: {
  initial: ConnectionSettings;
  onSave: (settings: ConnectionSettings) => Promise<void>;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const openrouter = draft.provider === "openrouter";
  const value = (openrouter ? draft.openrouterApiKey : draft.apiKey) ?? "";
  const valid = value.trim().startsWith(openrouter ? "sk-or-" : "sk-ant-");
  const label = openrouter ? "OpenRouter" : "Anthropic";
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !valid) return;
    setSaving(true);
    setError("");
    setSaved(false);
    setSaved(false);
    try {
      if (openrouter) await validateOpenRouterModel(draft.openrouterModel.trim());
      await onSave({ ...draft, apiKey: draft.apiKey?.trim() || null,
        openrouterApiKey: draft.openrouterApiKey?.trim() || null, openrouterModel: draft.openrouterModel.trim() });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const inputStyle = { width: "100%", boxSizing: "border-box" as const, padding: 10, fontSize: 16,
    borderRadius: 4, border: "1px solid #aaa", marginTop: 6 };
  return (
    <form onSubmit={save} style={compact ? {} : { maxWidth: 520, margin: "12vh auto", padding: 24, fontFamily: "system-ui" }}>
      {!compact && <h1 style={{ fontSize: 24 }}>Connect your AI provider</h1>}
      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0 }}>
        <label style={{ display: "block", color: "#333" }}>
          AI provider
          <select style={inputStyle} value={draft.provider} onChange={(e) => {
            setError("");
            setDraft({ ...draft, provider: e.target.value as HomepageProvider });
          }}>
            <option value="anthropic">Anthropic</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </label>
        <p style={{ color: "#555", lineHeight: 1.6 }}>
          {openrouter ? "Browsing summaries and selected signed-in page content go to OpenRouter and its inference provider."
            : "Browsing summaries and selected signed-in page content go to Anthropic."}
          {" "}Your key stays in this browser profile, except when authenticating with {label}.
          Anyone with access to the profile can read it. Use a personal, spending-limited key.
        </p>
        <label style={{ display: "block", color: "#333" }}>
          {label} API key
          <input type="password" autoComplete="off" value={value} style={inputStyle}
            placeholder={openrouter ? "sk-or-..." : "sk-ant-..."} required
            onChange={(e) => { setSaved(false); setDraft({ ...draft, [openrouter ? "openrouterApiKey" : "apiKey"]: e.target.value }); }} />
        </label>
        {openrouter && <label style={{ display: "block", marginTop: 16, color: "#333" }}>
          OpenRouter model ID
          <input list={compact ? "settings-models" : "setup-models"} value={draft.openrouterModel}
            style={inputStyle} required maxLength={200}
            onChange={(e) => { setSaved(false); setDraft({ ...draft, openrouterModel: e.target.value }); }} />
          <datalist id={compact ? "settings-models" : "setup-models"}>
            {OPENROUTER_MODEL_CHOICES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </datalist>
          <span style={{ display: "block", color: "#555", fontSize: 14, marginTop: 6 }}>
            Choose a suggested model or enter a custom ID. Tool support is checked on save and before each build.
          </span>
        </label>}
        {error && <p role="alert" style={{ ...errorBox, padding: 10, overflowWrap: "anywhere" }}>{error}</p>}
        <button type="submit" style={{ ...btn, marginTop: 16, opacity: valid && !saving ? 1 : 0.5 }}
          disabled={!valid || saving}>{saving ? openrouter ? "Checking model…" : "Saving…" : compact ? "Save connection" : "Save and continue"}</button>
        {saved && compact && <p role="status" style={{ color: "#333" }}>Connection saved.</p>}
        {compact && <p style={{ color: "#555", fontSize: 14 }}>Applies to the next build. Providers never switch automatically.</p>}
      </fieldset>
    </form>
  );
}
