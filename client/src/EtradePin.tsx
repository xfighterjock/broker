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
  const authorizeUrlRef = useRef<string | null>(null);

  if (auth !== "needs_pin" && auth !== "error") return null;

  function handleApiErr(err: { status?: number; message?: string }) {
    if (err.status === 401 && err.message === "auth required") setAuthNeeded(true);
    else setErr(err.message || "E*TRADE authorize failed");
  }

  async function openAuthorize(url: string) {
    authorizeUrlRef.current = url;
    window.open(url, "_blank", "noopener,noreferrer");
    setOpened(true);
  }

  async function authorize() {
    setBusy(true);
    try {
      const body = (await api("/api/etrade/oauth/start", {
        method: "POST",
        body: "{}",
      })) as { authorizeUrl?: string };
      const url = typeof body.authorizeUrl === "string" ? body.authorizeUrl : "";
      if (!/^https:\/\/us\.etrade\.com\/e\/t\/etws\/authorize\?/.test(url)) {
        setErr("E*TRADE authorize failed");
        return;
      }
      await openAuthorize(url);
      setErr(null);
    } catch (e: unknown) {
      handleApiErr(e as { status?: number; message?: string });
    } finally {
      setBusy(false);
    }
  }

  async function retryOpen() {
    const url = authorizeUrlRef.current;
    if (url) await openAuthorize(url);
    else await authorize();
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
      setErr(null);
      await onRefresh();
    } catch (e: unknown) {
      handleApiErr(e as { status?: number; message?: string });
    } finally {
      setBusy(false);
    }
  }

  const title = auth === "needs_pin" ? "E*TRADE needs PIN" : "E*TRADE error";

  return (
    <div className={`etrade-pin etrade-pin-${variant}`} data-etrade-auth={auth}>
      <span className="badge etrade-pin-badge">{title}</span>
      <button type="button" className="etrade-pin-auth" disabled={busy} onClick={() => void authorize()}>
        Authorize
      </button>
      {opened ? (
        <button type="button" className="tiny" disabled={busy} onClick={() => void retryOpen()}>
          Open again
        </button>
      ) : null}
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
