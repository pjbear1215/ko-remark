"use client";

import { useState, useMemo } from "react";

import Button from "@/components/Button";
import SectionDivider from "@/components/SectionDivider";
import TerminalOutput from "@/components/TerminalOutput";

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
    const content = `=== REKOIT 진단 결과 ===\n시간: ${new Date().toISOString()}\n기기: ${ip}\n\n${body}\n`;
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

  const logLines = useMemo(() => {
    if (!diagResult) return [];
    const lines: string[] = [];
    Object.entries(diagResult).forEach(([key, value]) => {
      lines.push(`=== ${key} ===`);
      lines.push(...value.split("\n"));
      lines.push(""); // spacer
    });
    return lines;
  }, [diagResult]);

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <SectionDivider label={title} />
      <div
        className="flex items-center justify-between p-4 bg-black/[0.03] border border-black/5"
      >
        <div>
          <p className="text-[16px] font-bold text-black">
            {title}
          </p>
          <p className="text-[13px] font-medium opacity-50 mt-0.5">
            {subtitle}
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={runDiagnosis} loading={diagnosing} className="font-bold">
          실행
        </Button>
      </div>
      {diagResult && (
        <div className="animate-fade-in">
          <TerminalOutput
            lines={logLines}
            title="System Diagnosis"
            initiallyOpen={true}
            showDownload={true}
            onDownload={downloadDiagnosis}
            maxHeight="400px"
          />
        </div>
      )}
    </div>
  );
}
