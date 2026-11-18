"use client";

import { upload } from "@vercel/blob/client";
import { useState } from "react";

export function DatasetUpload() {
  const [name, setName] = useState("Customer validation sample");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(""); setError("");
    try {
      if (!file) throw new Error("Choose a CSV file first");
      const createResponse = await fetch("/api/datasets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, sourceFilename: file.name }) });
      const created = await createResponse.json();
      if (!createResponse.ok) throw new Error(created.error || "Dataset creation failed");
      let uploadedRows: number | null = null;
      try {
        const blob = await upload(`datasets/${created.dataset.id}/${file.name}`, file, {
          access: "private",
          handleUploadUrl: `/api/datasets/${created.dataset.id}/upload-token`,
          clientPayload: JSON.stringify({ datasetId: created.dataset.id, sourceFilename: file.name, contentType: file.type || "text/csv", sizeBytes: file.size }),
          onUploadProgress: ({ percentage }) => setProgress(Math.round(percentage)),
        });
        const completeResponse = await fetch(`/api/datasets/${created.dataset.id}/upload/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pathname: blob.pathname, sourceFilename: file.name, contentType: file.type || "text/csv", sizeBytes: file.size }),
        });
        const completed = await completeResponse.json();
        if (!completeResponse.ok) throw new Error(completed.error || "Upload completion failed");
      } catch (storageError) {
        const message = storageError instanceof Error ? storageError.message : "Storage upload failed";
        if (file.size > 4_000_000 || !/storage|blob|token/i.test(message)) throw storageError;
        const form = new FormData(); form.set("file", file);
        const uploadResponse = await fetch(`/api/datasets/${created.dataset.id}/upload`, { method: "POST", body: form });
        const uploaded = await uploadResponse.json();
        if (!uploadResponse.ok) throw new Error(uploaded.error || "Upload failed");
        uploadedRows = uploaded.ingestion.rowCount;
      }
      setProgress(100);
      setMessage(uploadedRows === null ? "Upload complete. Validation is queued for the worker." : `${uploadedRows} rows accepted. Status: ready.`);
      window.setTimeout(() => window.location.reload(), 900);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Upload failed");
    } finally { setBusy(false); }
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="field"><label htmlFor="dataset-name">Dataset name</label><input id="dataset-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
      <div className="field"><label htmlFor="dataset-file">Tokenized CSV</label><input id="dataset-file" type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] || null)} /></div>
      <div className="notice">Required columns include event_id, trader_token, occurred_at, type, venue_id, and source_row_number. Direct identity fields receive an automatic rejection.</div>
      {error ? <div className="error">{error}</div> : null}
      {message ? <div className="notice">{message}</div> : null}
      {busy ? <div className="notice">Uploading {progress}%</div> : null}
      <button className="button" disabled={busy} type="submit">{busy ? "Uploading…" : "Upload and validate"}</button>
    </form>
  );
}
