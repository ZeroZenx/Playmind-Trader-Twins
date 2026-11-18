"use client";

import { useState } from "react";

type Dataset = { id: string; name: string };

export function ExperimentForm({ datasets }: { datasets: Dataset[] }) {
  const [name, setName] = useState("Baseline responsible-trading experiment");
  const [datasetId, setDatasetId] = useState(datasets[0]?.id || "");
  const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setMessage("");
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
      const processResponse = await fetch("/api/jobs/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: queued.job.id })
      });
      const processed = await processResponse.json();
      if (!processResponse.ok || processed.job?.status === "failed") throw new Error(processed.job?.error || "Experiment processing failed");
      setMessage(processed.job?.status === "succeeded" ? "Experiment complete. Report saved." : "Experiment queued for the worker.");
      window.setTimeout(() => window.location.reload(), 900);
  }
  return <form className="form" onSubmit={submit}>
    <div className="field"><label htmlFor="experiment-name">Experiment name</label><input id="experiment-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
    <div className="field"><label htmlFor="experiment-dataset">Ready dataset</label><select id="experiment-dataset" value={datasetId} onChange={(event) => setDatasetId(event.target.value)} disabled={!datasets.length}><option value="">{datasets.length ? "Choose a dataset" : "No ready datasets"}</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></div>
    {message ? <div className="notice">{message}</div> : null}
    <button className="button" disabled={!datasetId} type="submit">Create draft experiment</button>
  </form>;
}
