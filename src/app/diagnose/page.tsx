"use client";

import { useState } from "react";
import Button from "@/components/Button";
import { useSetup } from "@/lib/store";

export default function DiagnosePage(): React.JSX.Element {
  const { state } = useSetup();
  const [ip, setIp] = useState(state.ip || "10.11.99.1");
  const [password, setPassword] = useState(state.password || "");
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagResult, setDiagResult] = useState<Record<string, string> | null>(null);

  const runDiagnose = async (): Promise<void> => {
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
      setDiagResult({ error: "서버에 연결할 수 없습니다." });
    } finally {
      setDiagnosing(false);
    }
  };

  return (
    <div className="animate-fade-in-up">
      <div className="space-y-10">
        <div>
          <h1
            className="text-[36px] font-bold leading-tight"
            style={{ color: "var(--text-primary)" }}
          >
            키보드 진단
          </h1>
          <p
            className="mt-3 text-[17px]"
            style={{ color: "var(--text-muted)" }}
          >
            Type Folio 및 블루투스 키보드 입력 문제를 진단합니다.
          </p>
        </div>

        <div className="space-y-4 animate-fade-in-up stagger-1">
          <div>
            <label className="block text-[14px] mb-2" style={{ color: "var(--text-muted)" }}>
              IP 주소
            </label>
            <input
              type="text"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              className="w-full text-[17px] rounded-xl outline-none input-enhanced"
              style={{
                backgroundColor: "var(--bg-secondary)",
                color: "var(--text-primary)",
                border: "1.5px solid var(--border-light)",
                padding: "14px 20px",
              }}
            />
          </div>
          <div>
            <label className="block text-[14px] mb-2" style={{ color: "var(--text-muted)" }}>
              비밀번호
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full text-[17px] rounded-xl outline-none input-enhanced"
              style={{
                backgroundColor: "var(--bg-secondary)",
                color: "var(--text-primary)",
                border: "1.5px solid var(--border-light)",
                padding: "14px 20px",
              }}
            />
          </div>
          <Button onClick={runDiagnose} loading={diagnosing} size="lg">
            진단 실행
          </Button>
        </div>

        {diagResult && (
          <div className="overflow-hidden rounded-xl animate-fade-in" style={{ boxShadow: "var(--shadow-md)" }}>
            {/* macOS toolbar */}
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
              <span className="text-[11px] ml-2 font-mono" style={{ color: "rgba(255,255,255,0.3)" }}>
                진단 결과
              </span>
            </div>
            {/* Terminal body */}
            <div
              className="overflow-auto text-[13px] font-mono leading-[22px]"
              style={{
                background: "linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)",
                color: "var(--terminal-text)",
                maxHeight: "600px",
                padding: "20px 24px",
              }}
            >
              {Object.entries(diagResult).map(([key, value]) => (
                <div key={key} className="mb-4">
                  <div className="font-bold mb-1" style={{ color: "#818cf8" }}>
                    [{key}]
                  </div>
                  <pre className="whitespace-pre-wrap break-all">{value}</pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
