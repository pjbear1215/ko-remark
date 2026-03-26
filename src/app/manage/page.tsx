"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/Button";
import BluetoothPowerControl from "@/components/BluetoothPowerControl";
import KeyboardSwapControl from "@/components/KeyboardSwapControl";
import SectionDivider from "@/components/SectionDivider";
import { useSetup } from "@/lib/store";

export default function ManagePage() {
  const router = useRouter();
  const { state } = useSetup();

  const [mounted, setMounted] = useState(false);
  const [fontUploading, setFontUploading] = useState(false);
  const [fontResult, setFontResult] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagResult, setDiagResult] = useState<Record<string, string> | null>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && (!state.ip || !state.password)) {
      router.replace("/");
    }
  }, [mounted, state.ip, state.password, router]);

  if (!mounted || !state.ip || !state.password) {
    return null;
  }

  return (
    <div className="animate-fade-in-up">
      <div style={{ display: "flex", flexDirection: "column", gap: "40px" }}>
        <div className="flex items-start justify-between animate-fade-in-up">
          <div>
            <h1
              className="text-[36px] font-bold leading-tight"
              style={{ color: "var(--text-primary)" }}
            >
              설정 변경
            </h1>
            <p className="text-[15px]" style={{ color: "var(--text-muted)", marginTop: "8px" }}>
              다시 설정하지 않고, 현재 기기에서 필요한 항목만 바꿉니다.
            </p>
          </div>
          <Button variant="ghost" onClick={() => router.push("/")}>
            처음으로
          </Button>
        </div>

        <div className="animate-fade-in-up stagger-1" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionDivider label="원상복구" />
          <div
            className="card-interactive flex items-center justify-between"
            style={{ padding: "20px 24px" }}
          >
            <div>
              <p className="text-[16px] font-medium" style={{ color: "var(--text-primary)" }}>
                전체 원상복구
              </p>
              <p className="text-[14px]" style={{ color: "var(--text-muted)", marginTop: "4px" }}>
                설치된 항목을 감지한 뒤 원본 상태로 되돌립니다. 한글 폰트도 함께 제거됩니다.
              </p>
            </div>
            <Button variant="secondary" onClick={() => router.push("/uninstall")}>
              시작
            </Button>
          </div>
        </div>

        <div className="animate-fade-in-up stagger-2" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionDivider label="키보드" />
          <KeyboardSwapControl ip={state.ip} password={state.password} />
        </div>

        <div className="animate-fade-in-up stagger-3" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionDivider label="블루투스" />
          <div
            className="card-interactive flex items-center justify-between"
            style={{ padding: "20px 24px" }}
          >
            <div>
              <p className="text-[16px] font-medium" style={{ color: "var(--text-primary)" }}>
                키보드 재설정
              </p>
              <p className="text-[14px]" style={{ color: "var(--text-muted)", marginTop: "4px" }}>
                다시 스캔하고 다른 블루투스 키보드를 페어링하거나 기존 연결을 바꿉니다.
              </p>
            </div>
            <Button variant="secondary" onClick={() => router.push("/bluetooth?mode=manage")}>
              열기
            </Button>
          </div>
          <BluetoothPowerControl ip={state.ip} password={state.password} />
        </div>

        <div className="animate-fade-in-up stagger-4" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionDivider label="폰트 교체" />
          <input
            ref={fontInputRef}
            type="file"
            accept=".otf,.ttf"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setFontUploading(true);
              setFontResult(null);
              const formData = new FormData();
              formData.append("font", file);
              formData.append("ip", state.ip);
              formData.append("password", state.password);
              try {
                const res = await fetch("/api/font/upload", { method: "POST", body: formData });
                const data = await res.json();
                setFontResult(data.success ? data.message : `실패: ${data.error}`);
              } catch {
                setFontResult("서버 오류");
              } finally {
                setFontUploading(false);
                if (fontInputRef.current) fontInputRef.current.value = "";
              }
            }}
          />
          <div
            className="card-interactive flex items-center justify-between"
            style={{ padding: "20px 24px" }}
          >
            <span className="text-[15px] font-medium" style={{ color: "var(--text-muted)" }}>
              OTF/TTF 파일 업로드
            </span>
            <Button variant="secondary" size="sm" onClick={() => fontInputRef.current?.click()} loading={fontUploading}>
              {fontUploading ? "업로드 중..." : "선택"}
            </Button>
          </div>
          {fontResult && (
            <p className="text-[14px] animate-fade-in" style={{ color: fontResult.includes("실패") ? "var(--error)" : "var(--success)", paddingLeft: "4px" }}>
              {fontResult}
            </p>
          )}
        </div>

        <div className="animate-fade-in-up stagger-5" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionDivider label="진단" />
          <div
            className="card-interactive flex items-center justify-between"
            style={{ padding: "20px 24px" }}
          >
            <span className="text-[15px] font-medium" style={{ color: "var(--text-muted)" }}>
              문제 원인 확인
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                setDiagnosing(true);
                setDiagResult(null);
                try {
                  const res = await fetch("/api/diagnose", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ip: state.ip, password: state.password }),
                  });
                  const data = await res.json();
                  setDiagResult(data.results);
                } catch {
                  setDiagResult({ error: "서버 오류" });
                }
                setDiagnosing(false);
              }}
              loading={diagnosing}
            >
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
      </div>
    </div>
  );
}
