"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
import { useSetup } from "@/lib/store";
import { useGuard } from "@/lib/useGuard";

const DEVICE_NAMES: Record<string, string> = {
  "paper-pro": "Paper Pro",
  "paper-pro-move": "Paper Pro Move",
};

const DEVICE_DESCS: Record<string, string> = {
  "paper-pro": "한글 키패드 + 블루투스 키보드",
  "paper-pro-move": "한글 키패드 + 블루투스 키보드",
};

export default function ConnectionPage() {
  const allowed = useGuard();
  const router = useRouter();
  const { state, setState } = useSetup();
  const [testing, setTesting] = useState(false);
  const [autoTested, setAutoTested] = useState(false);
  const autoNavigatedRef = useRef(false);
  const [result, setResult] = useState<{
    connected: boolean;
    hostname?: string;
    firmware?: string;
    freeSpace?: string;
    model?: string;
    detectedDevice?: "paper-pro-move" | "paper-pro" | null;
    error?: string;
  } | null>(null);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch("/api/ssh/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: state.ip, password: state.password }),
      });
      const data = await res.json();
      setResult(data);
      if (data.connected) {
        setState({
          connected: true,
          detectedDevice: data.detectedDevice ?? null,
          deviceModel: data.model ?? "",
          deviceType: data.detectedDevice ?? state.deviceType,
        });
      }
    } catch {
      setResult({ connected: false, error: "서버 오류가 발생했습니다." });
    } finally {
      setTesting(false);
    }
  }, [state.ip, state.password, state.deviceType, setState]);

  useEffect(() => {
    if (!allowed) return;
    if (state.ip && state.password && !autoTested) {
      setAutoTested(true);
      handleTest();
    }
  }, [allowed, state.ip, state.password, autoTested, handleTest]);

  const isConnected = result?.connected === true;
  const detectedType = result?.detectedDevice;
  const isUnsupported = isConnected && !detectedType;
  const deviceReady = isConnected && detectedType;

  useEffect(() => {
    if (!allowed || testing || !deviceReady || autoNavigatedRef.current) {
      return;
    }
    autoNavigatedRef.current = true;
    router.push("/entry");
  }, [allowed, testing, deviceReady, router]);

  if (!allowed) return null;

  return (
    <div className="animate-fade-in-up">
      <StepIndicator currentStep={2} />

      <div className="space-y-10">
        <div>
          <h1
            className="text-[36px] font-bold leading-tight"
            style={{ color: "var(--text-primary)" }}
          >
            기기 확인
          </h1>
          <p
            className="mt-3 text-[17px]"
            style={{ color: "var(--text-muted)" }}
          >
            연결된 기기와 지원 모델 여부를 확인합니다.
          </p>
        </div>

        <div
          className="card-interactive rounded-xl flex items-center justify-between stagger-1"
          style={{ backgroundColor: "var(--bg-secondary)", padding: "16px 24px" }}
        >
          <div>
            <span className="text-[15px]" style={{ color: "var(--text-muted)" }}>
              {state.ip}
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleTest}
            loading={testing}
          >
            {testing ? "확인 중..." : "재시도"}
          </Button>
        </div>

        {testing && !result && (
          <div
            className="py-8 text-center rounded-xl"
            style={{ backgroundColor: "var(--bg-secondary)" }}
          >
            <div className="flex items-center justify-center gap-3">
              <span className="inline-flex gap-1" style={{ color: "var(--accent)" }}>
                {[0, 1, 2].map((i) => (
                  <span key={i} className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "currentColor", animation: "dotBounce 1.4s ease-in-out infinite", animationDelay: `${i * 0.16}s` }} />
                ))}
              </span>
              <span className="text-[16px]" style={{ color: "var(--text-muted)" }}>
                기기 정보를 확인 중...
              </span>
            </div>
          </div>
        )}

        {result && (
          <div
            className="rounded-xl stagger-2"
            style={{
              backgroundColor: isConnected ? "var(--success-light)" : "var(--error-light)",
              color: isConnected ? "var(--success)" : "var(--error)",
              padding: "20px 24px",
            }}
          >
            {isConnected ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-[17px]">기기 연결 성공</span>
                  <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                    {result.hostname} | {result.firmware} | {result.freeSpace}
                  </span>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="font-medium text-[17px]">연결 실패</p>
                <p className="text-[15px]" style={{ color: "var(--text-muted)" }}>
                  {result.error}
                </p>
                <p className="text-[14px]" style={{ color: "var(--text-muted)" }}>
                  비밀번호와 USB 연결 상태를 다시 확인한 뒤 처음 화면으로 돌아가세요.
                </p>
                <Button variant="secondary" size="sm" onClick={() => router.push("/")}>
                  처음으로
                </Button>
              </div>
            )}
          </div>
        )}

        {isConnected && (
          <div className="space-y-3 stagger-3">
            {(["paper-pro", "paper-pro-move"] as const).map((id) => {
              const isDetected = detectedType === id;
              return (
                <div
                  key={id}
                  className="card-interactive rounded-xl flex items-center justify-between transition-all"
                  style={{
                    backgroundColor: isDetected ? "var(--bg-card)" : "var(--bg-secondary)",
                    border: isDetected ? "2px solid var(--accent)" : "2px solid transparent",
                    opacity: isDetected ? 1 : 0.4,
                    padding: "20px 24px",
                  }}
                >
                  <div>
                    <span
                      className="text-[17px] font-medium"
                      style={{ color: isDetected ? "var(--text-primary)" : "var(--text-muted)" }}
                    >
                      {DEVICE_NAMES[id]}
                    </span>
                    <span className="text-[14px] ml-3" style={{ color: "var(--text-muted)" }}>
                      {DEVICE_DESCS[id]}
                    </span>
                  </div>
                  {isDetected && (
                    <span
                      className="text-[12px] flex-shrink-0"
                      style={{ backgroundColor: "var(--success-light)", color: "var(--success)", borderRadius: "9999px", padding: "4px 12px" }}
                    >
                      감지됨
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {isUnsupported && (
          <div
            className="py-5 px-6 rounded-xl"
            style={{ backgroundColor: "var(--error-light)", color: "var(--error)" }}
          >
            <p className="font-medium text-[16px]">미지원 기기</p>
            <p className="text-[14px] mt-1" style={{ color: "var(--text-muted)" }}>
              {result?.model && result.model !== "unknown" ? `${result.model}은(는)` : "이 기기는"} 지원되지 않습니다. Paper Pro 또는 Paper Pro Move만 사용할 수 있습니다.
            </p>
          </div>
        )}

        <div className="flex justify-between pt-4">
          <Button variant="ghost" onClick={() => router.push("/prerequisites")}>
            이전
          </Button>
          <Button
            onClick={() => router.push("/entry")}
            disabled={!deviceReady}
            size="lg"
          >
            다음
          </Button>
        </div>
      </div>
    </div>
  );
}
