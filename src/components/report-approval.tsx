"use client";

import { useState } from "react";

export function ReportApproval({ reportId, approvedAt, allowed }: { reportId: string; approvedAt: string | null; allowed: boolean }) {
  const [approved, setApproved] = useState(Boolean(approvedAt));
  const [error, setError] = useState("");
  async function approve() {
    setError("");
    const response = await fetch(`/api/reports/${reportId}/approve`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) { setError(body.error || "Approval failed"); return; }
    setApproved(true);
  }
  if (approved) return <span className="status">Approved</span>;
  if (!allowed) return <span className="status amber">Review required</span>;
  return <span><button className="button" type="button" onClick={approve}>Approve report</button>{error ? <span className="error">{error}</span> : null}</span>;
}
