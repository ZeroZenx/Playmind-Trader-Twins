"use client";

import { FormEvent, useState } from "react";
import { authClient } from "@/src/lib/auth/client";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = mode === "sign-up"
      ? await authClient.signUp.email({ name, email, password, callbackURL: "/dashboard" })
      : await authClient.signIn.email({ email, password, callbackURL: "/dashboard" });
    if (result.error) {
      setError(result.error.message || "Authentication failed");
      setBusy(false);
      return;
    }
    window.location.href = "/dashboard";
  }

  return (
    <form className="form" onSubmit={submit}>
      {mode === "sign-up" ? <div className="field"><label htmlFor="name">Name</label><input id="name" value={name} onChange={(event) => setName(event.target.value)} required /></div> : null}
      <div className="field"><label htmlFor="email">Work email</label><input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
      <div className="field"><label htmlFor="password">Password</label><input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /></div>
      {error ? <div className="error">{error}</div> : null}
      <button className="button" disabled={busy}>{busy ? "Working..." : mode === "sign-up" ? "Create account" : "Sign in"}</button>
    </form>
  );
}
