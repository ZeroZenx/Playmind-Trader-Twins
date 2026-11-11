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
    const body = await response.json(); setMessage(response.ok ? "Experiment created as draft." : body.error || "Experiment creation failed");
    if (response.ok) window.setTimeout(() => window.location.reload(), 900);
  }
  return <form className="form" onSubmit={submit}>
    <div className="field"><label htmlFor="experiment-name">Experiment name</label><input id="experiment-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
    <div className="field"><label htmlFor="experiment-dataset">Ready dataset</label><select id="experiment-dataset" value={datasetId} onChange={(event) => setDatasetId(event.target.value)} disabled={!datasets.length}><option value="">{datasets.length ? "Choose a dataset" : "No ready datasets"}</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></div>
    {message ? <div className="notice">{message}</div> : null}
    <button className="button" disabled={!datasetId} type="submit">Create draft experiment</button>
  </form>;
}
