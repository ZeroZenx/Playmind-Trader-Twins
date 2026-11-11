"use client";

import { useState } from "react";

type Task = { task_key: string; title: string; description: string; status: string };

export function OnboardingChecklist({ initialTasks }: { initialTasks: Task[] }) {
  const [tasks, setTasks] = useState(initialTasks);
  const [busy, setBusy] = useState<string | null>(null);
  async function update(taskKey: string, status: string) {
    setBusy(taskKey);
    const response = await fetch("/api/onboarding", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskKey, status }) });
    if (response.ok) setTasks((current) => current.map((task) => task.task_key === taskKey ? { ...task, status } : task));
    setBusy(null);
  }
  return (
    <div className="checklist">
      {tasks.map((task) => (
        <div className="check" key={task.task_key}>
          <div className="check-mark">{task.status === "done" ? "✓" : "·"}</div>
          <div style={{ flex: 1 }}><strong>{task.title}</strong><div className="muted" style={{ marginTop: 5 }}>{task.description}</div></div>
          <button className="button ghost" disabled={busy === task.task_key} onClick={() => update(task.task_key, task.status === "done" ? "pending" : "done")}>{busy === task.task_key ? "Saving" : task.status === "done" ? "Undo" : "Mark done"}</button>
        </div>
      ))}
    </div>
  );
}
