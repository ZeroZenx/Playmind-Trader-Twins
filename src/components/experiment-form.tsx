"use client";

import { useState } from "react";

type Dataset = { id: string; name: string };

export function ExperimentForm({ datasets }: { datasets: Dataset[] }) {
  const [name, setName] = useState("Baseline responsible-trading experiment");
  const [datasetId, setDatasetId] = useState(datasets[0]?.id || "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setMessage(""); setError(""); setBusy(true);
    try {
      const response = await fetch("/api/experiments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, datasetId, horizonDays: 30, randomSeed: 42 }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Experiment creation failed");
      const runResponse = await fetch(`/api/experiments/${body.experiment.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdoutReplicates: 3, sweepReplicates: 3, horizonDays: 30 })
      });
      const queued = await runResponse.json();
      if (!runResponse.ok) throw new Error(queued.error || "Experiment queue failed");
      setMessage("Experiment queued. Waiting for the worker.");
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const statusResponse = await fetch(`/api/experiments/${body.experiment.id}`, { cache: "no-store" });
        const statusBody = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(statusBody.error || "Experiment status failed");
        const status = statusBody.experiment?.status;
        if (status === "succeeded") {
          setMessage("Experiment complete. Report saved.");
          window.setTimeout(() => window.location.reload(), 700);
          return;
        }
        if (status === "failed") throw new Error(statusBody.job?.error_message || "Experiment processing failed");
        setMessage(`Experiment ${status || "queued"}. Worker progress is being checked.`);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Experiment failed");
    } finally {
      setBusy(false);
    }
  }
  return <form className="form" onSubmit={submit}>
    <div className="field"><label htmlFor="experiment-name">Experiment name</label><input id="experiment-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
    <div className="field"><label htmlFor="experiment-dataset">Ready dataset</label><select id="experiment-dataset" value={datasetId} onChange={(event) => setDatasetId(event.target.value)} disabled={!datasets.length}><option value="">{datasets.length ? "Choose a dataset" : "No ready datasets"}</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></div>
    {error ? <div className="error">{error}</div> : null}
    {message ? <div className="notice">{message}</div> : null}
    <button className="button" disabled={!datasetId || busy} type="submit">{busy ? "Running…" : "Create and run experiment"}</button>
  </form>;
}
