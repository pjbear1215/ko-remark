"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
import Checkbox from "@/components/Checkbox";
import ProgressBar from "@/components/ProgressBar";
import TerminalOutput from "@/components/TerminalOutput";
import ErrorReport from "@/components/ErrorReport";
import { useSetup } from "@/lib/store";
import { useGuard } from "@/lib/useGuard";
import { ensureSshSession } from "@/lib/client/sshSession";

type InstallStatus = "ready" | "installing" | "complete" | "error";

export default function InstallPage() {
  const allowed = useGuard();
  const router = useRouter();
  const { state, setState } = useSetup();
  const [status, setStatus] = useState<InstallStatus>("ready");
  const [logs, setLogs] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState("");
  const [lockPasswordDisabled, setLockPasswordDisabled] = useState(false);
  const [developerModeEnabled, setDeveloperModeEnabled] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const statusRef = useRef<InstallStatus>("ready");

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  if (!allowed) return null;

  const startInstall = async () => {
    eventSourceRef.current?.close();

    if (!state.ip || !state.password) {
      setStatus("error");
      setLogs(["ERROR: IP 주소 또는 비밀번호가 없습니다."]);
      setErrors(["IP 주소 또는 비밀번호가 없습니다."]);
      return;
    }

    setState({ installBtKeyboard: true });
    setStatus("installing");
    setLogs([]);
    setErrors([]);
    setProgress(0);

    const params = new URLSearchParams({
      bt: "true",
      swapLeftCtrlCapsLock: state.swapLeftCtrlCapsLock ? "true" : "false",
    });

    try {
      await ensureSshSession(state.ip, state.password);

      const checkRes = await fetch(`/api/ssh/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: state.ip, password: state.password }),
      });
      const checkData = await checkRes.json();
      if (!checkData.connected) {
        setStatus("error");
        const errMsg = checkData.error ?? "IP 또는 비밀번호를 확인하세요.";
        setLogs([`ERROR: SSH 연결 실패 — ${errMsg}`]);
        setErrors([`SSH 연결 실패: ${errMsg}`]);
        return;
      }
    } catch {
      setStatus("error");
      setLogs(["ERROR: 서버에 연결할 수 없습니다."]);
      setErrors(["서버에 연결할 수 없습니다."]);
      return;
    }

    const es = new EventSource(`/api/install/stream?${params}`);
    eventSourceRef.current = es;

    es.addEventListener("step", (e) => {
      const data = JSON.parse(e.data);
      setCurrentStep(data.name);
      if (data.status === "complete") {
        setLogs((prev) => [...prev, `OK: ${data.name}`]);
      }
    });

    es.addEventListener("log", (e) => {
      const data = JSON.parse(e.data);
      const line = data.line as string;
      setLogs((prev) => [...prev, line]);
      if (line.startsWith("ERROR") || line.startsWith("FAIL")) {
        setErrors((prev) => [...prev, line]);
      }
    });

    es.addEventListener("progress", (e) => {
      const data = JSON.parse(e.data);
      setProgress(data.percent);
    });

    es.addEventListener("complete", () => {
      setStatus("complete");
      setProgress(100);
      es.close();
    });

    es.addEventListener("error", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        const errLine = `ERROR: ${data.message}`;
        setLogs((prev) => [...prev, errLine]);
        setErrors((prev) => [...prev, errLine]);
      } catch {
        if (statusRef.current === "installing") {
          setLogs((prev) => [...prev, "ERROR: 연결이 끊어졌습니다."]);
          setErrors((prev) => [...prev, "연결이 끊어졌습니다."]);
        }
      }
      setStatus("error");
      es.close();
    });

    es.onerror = () => {
      if (statusRef.current === "installing") {
        setStatus("error");
        setLogs((prev) => [...prev, "ERROR: SSE 연결이 끊어졌습니다."]);
        setErrors((prev) => [...prev, "SSE 연결이 끊어졌습니다."]);
      }
      es.close();
    };
  };

  const handleNext = () => {
    router.push("/bluetooth");
  };

  return (
    <div className="animate-fade-in-up">
      <StepIndicator currentStep={4} />

      <div className="space-y-10">
        <div>
          <h1
            className="text-[36px] font-bold leading-tight"
            style={{ color: "var(--text-primary)" }}
          >
            설치
          </h1>
          <p
            className="mt-3 text-[17px]"
            style={{ color: "var(--text-muted)" }}
          >
            Type Folio와 블루투스 키보드용 한글 입력을 설치합니다.
          </p>
        </div>

        {status === "ready" && (
          <div className="space-y-3 stagger-1">
            <div
              className="p-5 rounded-xl"
              style={{
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border-light)",
              }}
            >
              <p className="text-[15px] font-medium" style={{ color: "var(--text-primary)" }}>
                설치 구성
              </p>
              <p className="text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>
                Type Folio 및 블루투스 키보드용 한글 입력을 설치합니다.
              </p>
            </div>
            <Checkbox
              checked={state.swapLeftCtrlCapsLock}
              onChange={(checked) => setState({ swapLeftCtrlCapsLock: checked })}
              label="왼쪽 CapsLock과 왼쪽 Ctrl 위치 바꾸기"
              description="켜면 왼쪽 CapsLock은 Ctrl처럼, 왼쪽 Ctrl은 CapsLock처럼 동작합니다."
            />

            {/* 설치 전 확인 사항 */}
            <div className="space-y-3 mt-6 stagger-2">
              <span
                className="text-[12px] font-semibold uppercase tracking-[0.12em]"
                style={{
                  color: "var(--text-muted)",
                  backgroundColor: "var(--bg-secondary)",
                  padding: "5px 14px",
                  borderRadius: "var(--radius-full)",
                  border: "1px solid var(--border-light)",
                }}
              >
                설치 전 확인
              </span>

              {/* 개발자 모드 확인 */}
              <div
                className="p-5 rounded-xl"
                style={{
                  backgroundColor: "var(--warning-bg, rgba(255,204,0,0.1))",
                  border: `1px solid ${developerModeEnabled ? "var(--success)" : "var(--warning)"}`,
                }}
              >
                <label className="flex items-start gap-4 cursor-pointer">
                  <div
                    className="flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors"
                    style={{
                      width: "22px",
                      height: "22px",
                      backgroundColor: developerModeEnabled ? "var(--accent)" : "transparent",
                      border: developerModeEnabled ? "none" : "2px solid var(--border)",
                      borderRadius: "6px",
                    }}
                  >
                    {developerModeEnabled && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  <input
                    type="checkbox"
                    checked={developerModeEnabled}
                    onChange={(e) => setDeveloperModeEnabled(e.target.checked)}
                    className="sr-only"
                  />
                  <div>
                    <p className="text-[15px] font-medium" style={{ color: developerModeEnabled ? "var(--success)" : "var(--warning)" }}>
                      개발자 모드를 활성화했습니다
                    </p>
                    <p className="text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>
                      설정 &gt; 일반 &gt; 보안 &gt; 개발자 모드를 켜주세요.
                      개발자 모드가 꺼져 있으면 SSH 접속이 불가합니다.
                    </p>
                  </div>
                </label>
              </div>

              {/* 잠금 비밀번호 삭제 확인 */}
              <div
                className="p-5 rounded-xl"
                style={{
                  backgroundColor: "var(--warning-bg, rgba(255,204,0,0.1))",
                  border: `1px solid ${lockPasswordDisabled ? "var(--success)" : "var(--warning)"}`,
                }}
              >
                <label className="flex items-start gap-4 cursor-pointer">
                  <div
                    className="flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors"
                    style={{
                      width: "22px",
                      height: "22px",
                      backgroundColor: lockPasswordDisabled ? "var(--accent)" : "transparent",
                      border: lockPasswordDisabled ? "none" : "2px solid var(--border)",
                      borderRadius: "6px",
                    }}
                  >
                    {lockPasswordDisabled && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  <input
                    type="checkbox"
                    checked={lockPasswordDisabled}
                    onChange={(e) => setLockPasswordDisabled(e.target.checked)}
                    className="sr-only"
                  />
                  <div>
                    <p className="text-[15px] font-medium" style={{ color: lockPasswordDisabled ? "var(--success)" : "var(--warning)" }}>
                      잠금 화면 비밀번호를 삭제했습니다
                    </p>
                    <p className="text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>
                      설정 &gt; 일반 &gt; 보안 &gt; 잠금 화면에서 비밀번호를 삭제하세요.
                      설치 중 기기가 재시작되며, 잠금이 설정되어 있으면 자동 진입이 안 됩니다.
                    </p>
                  </div>
                </label>
              </div>
            </div>

          </div>
        )}

        {/* 진행 상태 */}
        {status !== "ready" && (
          <div className="space-y-4">
            <ProgressBar
              progress={progress}
              status={status === "error" ? "error" : status === "complete" ? "complete" : "active"}
              currentStep={currentStep}
            />
            <TerminalOutput lines={logs} maxHeight="280px" />
          </div>
        )}

        {/* 완료 */}
        {status === "complete" && (
          <div
            className="p-6 rounded-xl text-[17px] font-medium text-center animate-fade-in"
            style={{ backgroundColor: "var(--success-light)", color: "var(--success)" }}
          >
            설치가 완료되었습니다.
          </div>
        )}

        {status === "complete" && errors.length > 0 && (
          <ErrorReport errors={errors} allLogs={logs} context="설치" />
        )}

        {/* 에러 */}
        {status === "error" && (
          <div className="space-y-4">
            <div
              className="p-6 rounded-xl animate-fade-in"
              style={{ backgroundColor: "var(--error-light)", color: "var(--error)" }}
            >
              <p className="text-[17px] font-medium">오류가 발생했습니다.</p>
              <p className="text-[15px] mt-2" style={{ color: "var(--text-muted)" }}>
                오류 상세를 확인하거나 로그 파일을 다운로드하세요.
              </p>
            </div>
            <ErrorReport errors={errors} allLogs={logs} context="설치" />
            <Button variant="secondary" size="sm" onClick={startInstall}>
              재시도
            </Button>
          </div>
        )}

        {/* 로그 다운로드 */}
        {(status === "complete" || status === "error") && logs.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
              const header = `=== 한글 설치 로그 ===\n시간: ${new Date().toISOString()}\n상태: ${status === "complete" ? "완료" : "오류"}\n오류 수: ${errors.length}\n\n`;
              const errorSection = errors.length > 0
                ? `--- 오류 ---\n${errors.join("\n")}\n\n`
                : "";
              const logSection = `--- 전체 로그 ---\n${logs.join("\n")}`;
              const content = header + errorSection + logSection;
              const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `hangul-install-log-${timestamp}.txt`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            로그 파일 다운로드
          </Button>
        )}

        {/* 네비게이션 */}
        <div className="flex justify-between pt-4">
          <Button
            variant="ghost"
            onClick={() => router.push("/entry")}
            disabled={status === "installing"}
          >
            이전
          </Button>
          {status === "ready" ? (
            <Button
              onClick={startInstall}
              disabled={!developerModeEnabled || !lockPasswordDisabled}
              size="lg"
            >
              설치 시작
            </Button>
          ) : (
            <Button onClick={handleNext} disabled={status !== "complete"} size="lg">
              다음
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
