"use client";

import { useState } from "react";

import Button from "@/components/Button";
import SectionDivider from "@/components/SectionDivider";

interface DiagnosisPanelProps {
  ip: string;
  password: string;
  title?: string;
  subtitle?: string;
  className?: string;
}

export default function DiagnosisPanel({
  ip,
  password,
  title = "진단",
  subtitle = "키보드 문제 진단",
  className,
}: DiagnosisPanelProps) {
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagResult, setDiagResult] = useState<Record<string, string> | null>(null);

  const runDiagnosis = async () => {
    setDiagnosing(true);
    setDiagResult(null);
    try {
      const res = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip, password }),
      });
      const data = await res.json();
      setDiagResult(data.results);
    } catch {
      setDiagResult({ error: "서버 오류" });
    } finally {
      setDiagnosing(false);
    }
  };

  const downloadDiagnosis = () => {
    if (!diagResult) return;

    const timestamp = new Date()
      .toISOString()
      .replace(/[:]/g, "-")
      .replace(/\..+$/, "");
    const body = Object.entries(diagResult)
      .map(([key, value]) => `--- ${key} ---\n${value}`.trimEnd())
      .join("\n\n");
    const content = `=== ReKoIt 진단 결과 ===\n시간: ${new Date().toISOString()}\n기기: ${ip}\n\n${body}\n`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `rekoit-diagnose-${timestamp}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <SectionDivider label={title} />
      <div
        className="card-interactive flex items-center justify-between"
        style={{ padding: "20px 24px" }}
      >
        <span className="text-[15px] font-medium" style={{ color: "var(--text-muted)" }}>
          {subtitle}
        </span>
        <Button variant="secondary" size="sm" onClick={runDiagnosis} loading={diagnosing}>
          실행
        </Button>
      </div>
      {diagResult && (
        <div
          className="card-static overflow-hidden animate-fade-in"
          style={{ border: "none" }}
        >
          <div
            className="flex items-center gap-2"
            style={{
              backgroundColor: "rgba(26, 26, 46, 0.8)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
              padding: "10px 16px",
            }}
          >
            <div className="flex gap-1.5">
              <div className="w-[10px] h-[10px] rounded-full" style={{ backgroundColor: "#f87171" }} />
              <div className="w-[10px] h-[10px] rounded-full" style={{ backgroundColor: "#fbbf24" }} />
              <div className="w-[10px] h-[10px] rounded-full" style={{ backgroundColor: "#4ade80" }} />
            </div>
            <span className="text-[11px] font-mono" style={{ color: "rgba(255,255,255,0.3)", marginLeft: "8px" }}>
              진단 결과
            </span>
            <div style={{ marginLeft: "auto" }}>
              <Button variant="ghost" size="sm" onClick={downloadDiagnosis}>
                파일로 저장
              </Button>
            </div>
          </div>
          <div
            className="overflow-auto text-[12px] font-mono leading-[22px] terminal-scroll"
            style={{
              background: "linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)",
              color: "var(--terminal-text)",
              maxHeight: "400px",
              padding: "20px 24px",
            }}
          >
            {Object.entries(diagResult).map(([key, value]) => (
              <div key={key} style={{ marginBottom: "12px" }}>
                <div style={{ color: "#818cf8" }}>--- {key} ---</div>
                <pre className="whitespace-pre-wrap break-all">{value}</pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
