"use client";

import { useState } from "react";
import { authClient } from "@/src/lib/auth/client";

export function AuthButtons() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setBusy(true);
    setError(null);
    const result = await authClient.signOut();
    if (result.error) setError(result.error.message || "Sign-out failed");
    window.location.href = "/";
  }

  return (
    <div className="button-row">
      <button className="button ghost" onClick={signOut} disabled={busy}>
        {busy ? "Signing out..." : "Sign out"}
      </button>
      {error ? <span className="error">{error}</span> : null}
    </div>
  );
}
