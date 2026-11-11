"use client";

import { useState } from "react";

export function DatasetUpload() {
  const [name, setName] = useState("Customer validation sample");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(""); setError("");
    try {
      if (!file) throw new Error("Choose a CSV file first");
      const createResponse = await fetch("/api/datasets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, sourceFilename: file.name }) });
      const created = await createResponse.json();
      if (!createResponse.ok) throw new Error(created.error || "Dataset creation failed");
      const form = new FormData(); form.set("file", file);
      const uploadResponse = await fetch(`/api/datasets/${created.dataset.id}/upload`, { method: "POST", body: form });
      const uploaded = await uploadResponse.json();
      if (!uploadResponse.ok) throw new Error(uploaded.error || "Upload failed");
      setMessage(`${uploaded.ingestion.rowCount} rows accepted. Status: ${uploaded.ingestion.status}.`);
      window.setTimeout(() => window.location.reload(), 900);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Upload failed");
    } finally { setBusy(false); }
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="field"><label htmlFor="dataset-name">Dataset name</label><input id="dataset-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
      <div className="field"><label htmlFor="dataset-file">Tokenized CSV, max 4 MB</label><input id="dataset-file" type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] || null)} /></div>
      <div className="notice">Required columns include event_id, trader_token, occurred_at, type, venue_id, and source_row_number. Direct identity fields receive an automatic rejection.</div>
      {error ? <div className="error">{error}</div> : null}
      {message ? <div className="notice">{message}</div> : null}
      <button className="button" disabled={busy} type="submit">{busy ? "Validating…" : "Upload and validate"}</button>
    </form>
  );
}
