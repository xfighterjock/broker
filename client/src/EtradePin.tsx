import { useRef, useState, type FormEvent } from "react";
import type { EtradeAuthState } from "../../shared/types";
import { api } from "./api";

export function EtradePinBar({
  auth,
  variant = "header",
  onRefresh,
  setAuthNeeded,
  setErr,
}: {
  auth: EtradeAuthState | undefined;
  variant?: "header" | "essentials";
  onRefresh: () => Promise<void> | void;
  setAuthNeeded: (v: boolean) => void;
  setErr: (v: string | null) => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [popupNote, setPopupNote] = useState<string | null>(null);
  const authorizeUrlRef = useRef<string | null>(null);

  if (!auth || auth === "ok") return null;

  function handleApiErr(err: { status?: number; message?: string }) {
    if (err.status === 401 && err.message === "auth required") setAuthNeeded(true);
    else setErr(err.message || "E*TRADE authorize failed");
  }

  function navigatePopup(popup: Window | null, url: string): boolean {
    if (!popup || popup.closed) return false;
    try {
      popup.opener = null;
    } catch {
      /* The E*TRADE page must not script this window. */
    }
    popup.location.replace(url);
    return true;
  }

  function openBlank(): Window | null {
    // Must run in the click turn. A later window.open (after await) is blocked on iOS Safari.
    return window.open("about:blank", "_blank");
  }

  async function authorize() {
    const popup = openBlank();
    setBusy(true);
    setPopupNote(null);
    try {
      const body = (await api("/api/etrade/oauth/start", {
        method: "POST",
        body: "{}",
      })) as { authorizeUrl?: string };
      const url = typeof body.authorizeUrl === "string" ? body.authorizeUrl : "";
      if (!/^https:\/\/us\.etrade\.com\/e\/t\/etws\/authorize\?/.test(url)) {
        popup?.close();
        setErr("E*TRADE authorize failed");
        return;
      }
      authorizeUrlRef.current = url;
      if (!navigatePopup(popup, url)) {
        popup?.close();
        setOpened(true);
        setPopupNote("Pop-up blocked. Allow pop-ups for Event Gate, then tap Open again.");
        return;
      }
      setOpened(true);
      setPopupNote(null);
      setErr(null);
    } catch (e: unknown) {
      popup?.close();
      handleApiErr(e as { status?: number; message?: string });
    } finally {
      setBusy(false);
    }
  }

  function retryOpen() {
    const url = authorizeUrlRef.current;
    if (!url) {
      void authorize();
      return;
    }
    const popup = openBlank();
    if (!navigatePopup(popup, url)) {
      popup?.close();
      setPopupNote("Pop-up blocked. Allow pop-ups for Event Gate, then tap Open again.");
      return;
    }
    setOpened(true);
    setPopupNote(null);
    setErr(null);
  }

  async function submitPin(e: FormEvent) {
    e.preventDefault();
    const value = pin.trim();
    if (!value) return;
    setBusy(true);
    try {
      await api("/api/etrade/oauth/pin", {
        method: "POST",
        body: JSON.stringify({ pin: value }),
      });
      setPin("");
      authorizeUrlRef.current = null;
      setOpened(false);
      setPopupNote(null);
      setErr(null);
      await onRefresh();
    } catch (e: unknown) {
      handleApiErr(e as { status?: number; message?: string });
    } finally {
      setBusy(false);
    }
  }

  const title =
    auth === "needs_pin" ? "E*TRADE needs PIN" : auth === "error" ? "E*TRADE error" : "E*TRADE needs re-auth";

  return (
    <div className={`etrade-pin etrade-pin-${variant}`} data-etrade-auth={auth} role="region" aria-label={title}>
      <button type="button" className="etrade-pin-auth" disabled={busy} onClick={() => void authorize()}>
        {title} — Re-authorize
      </button>
      <p className="etrade-pin-hint">E*TRADE shows a PIN. Type it here. This does not place an order.</p>
      {opened ? (
        <button type="button" className="tiny" disabled={busy} onClick={() => retryOpen()}>
          Open again
        </button>
      ) : null}
      {popupNote ? <p className="etrade-pin-hint">{popupNote}</p> : null}
      <form className="etrade-pin-form" onSubmit={(e) => void submitPin(e)}>
        <label className="etrade-pin-label">
          <span className="etrade-pin-label-text">PIN</span>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="text"
            aria-label="E*TRADE PIN"
            disabled={busy}
          />
        </label>
        <button type="submit" className="good" disabled={busy || !pin.trim()}>
          Submit PIN
        </button>
      </form>
    </div>
  );
}
