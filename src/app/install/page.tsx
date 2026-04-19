"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
import ProgressBar from "@/components/ProgressBar";
import TerminalOutput from "@/components/TerminalOutput";
import ErrorReport from "@/components/ErrorReport";
import Checkbox from "@/components/Checkbox";
import { useSetup } from "@/lib/store";
import { useGuard } from "@/lib/useGuard";
import { ensureSshSession } from "@/lib/client/sshSession";

type InstallStatus = "ready" | "installing" | "complete" | "error";

export default function InstallPage() {
  const allowed = useGuard();
  const router = useRouter();
  const { state } = useSetup();
  const [status, setStatus] = useState<InstallStatus>("ready");
  const [logs, setLogs] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState("");
  const [developerModeEnabled, setDeveloperModeEnabled] = useState(false);
  const [lockPasswordDisabled, setLockPasswordDisabled] = useState(false);
  const [btSelected, setBtSelected] = useState(state.installBtKeyboard || state.installHangul);
  const [swapCaps, setSwapCaps] = useState(state.swapLeftCtrlCapsLock);
  const eventSourceRef = useRef<EventSource | null>(null);
  const statusRef = useRef<InstallStatus>("ready");

  const effectiveBtSelected = btSelected;
  const shouldConfigureBluetoothAfterInstall = effectiveBtSelected;
  const logFilePrefix = "rekoit-install";
  const errorContext = "설치";

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  if (!allowed) return null;

  const startInstall = async () => {
    statusRef.current = "installing";
    setStatus("installing");
    setLogs([]);
    setErrors([]);
    setProgress(0);

    // === Step 0: 사전 접속 확인 (비밀번호 검증) ===
    try {
      setLogs(["INFO: 기기 연결 및 SSH 인증 확인 중..."]);
      const checkRes = await fetch("/api/ssh/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: state.ip, password: state.password }),
      });
      const checkData = await checkRes.json();
      if (!checkRes.ok || !checkData.reachable) {
        throw new Error(checkData.error || "SSH 연결에 실패했습니다.");
      }
      setLogs((prev) => [...prev, "OK: SSH 인증 성공"]);

      // === Step 0.5: SSH 세션 쿠키 설정 ===
      await ensureSshSession(state.ip, state.password);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "SSH 연결 실패";
      setLogs((prev) => [...prev, `ERROR: ${msg}`]);
      setErrors([msg]);
      setStatus("error");
      statusRef.current = "error";
      return;
    }

    const params = new URLSearchParams({
      hangul: String(state.installHangul),
      bt: String(effectiveBtSelected),
      swapLeftCtrlCapsLock: String(swapCaps),
    });

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

    es.onerror = (e) => {
      if (statusRef.current === "complete" || statusRef.current === "error") return;

      try {
        const messageEvent = e as MessageEvent;
        if (messageEvent.data) {
          const data = JSON.parse(messageEvent.data);
          const errLine = `ERROR: ${data.message}`;
          setLogs((prev) => [...prev, errLine]);
          setErrors((prev) => [...prev, errLine]);
        } else {
          throw new Error("No data");
        }
      } catch {
        if (statusRef.current === "installing") {
          setLogs((prev) => [...prev, "ERROR: 연결이 끊어졌습니다."]);
          setErrors((prev) => [...prev, "연결이 끊어졌습니다."]);
        }
      }
      setStatus("error");
      statusRef.current = "error";
      es.close();
    };
  };

  const handleNext = () => {
    router.push(shouldConfigureBluetoothAfterInstall ? "/bluetooth" : "/complete");
  };

  return (
    <div className="animate-fade-in-up">
      <StepIndicator currentStep={4} />

      <div className="space-y-5">
        <div>
          <h1
            className="text-[36px] font-bold leading-tight"
            style={{ color: "#000000" }}
          >
            설치 준비
          </h1>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[18px]">💡</span>
            <p className="text-[15px] font-medium" style={{ color: "#666666" }}>
              <strong>Shift + Space</strong> 또는 <strong>오른쪽 Alt</strong>로 언어를 전환할 수 있습니다.
            </p>
          </div>
        </div>

        <div className="stagger-1">
          <div className="operator-card operator-card-strong" style={{ padding: "16px 20px", border: "1.5px solid #000000" }}>
            <div className="space-y-6">
              {/* 기기 정보 */}
              <div className="flex items-center justify-between pb-4 border-b border-black/10">
                <span className="text-[13px] font-bold uppercase tracking-wider">Connected Device</span>
                <div className="text-right">
                  <span className="text-[15px] font-bold">{state.deviceModel || "reMarkable 기기"}</span>
                  <span className="ml-2 text-[13px] font-mono text-muted">({state.ip})</span>
                </div>
              </div>

              {status === "ready" ? (
                <div className="space-y-6">
                  {/* 적용될 기능 */}
                  <div className="space-y-3">
                    <label className="block text-[13px] font-bold uppercase tracking-wider">적용될 기능</label>
                    <div className="space-y-2">
                      {state.installHangul && (
                        <div className="flex items-center justify-between p-4 bg-black border border-black">
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 bg-white border border-white flex items-center justify-center font-bold text-[13px] text-black">KO</div>
                            <span className="font-bold text-white">한글 입력 엔진</span>
                          </div>
                          <span className="text-[11px] font-bold text-white/60 uppercase tracking-widest">Ready</span>
                        </div>
                      )}
                      {effectiveBtSelected && (
                        <div className="flex items-center justify-between p-4 bg-black border border-black">
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 bg-white border border-white flex items-center justify-center text-black">
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <path d="M7 7l10 10-5 5V2l5 5L7 17" />
                              </svg>
                            </div>
                            <span className="font-bold text-white">블루투스 도우미</span>
                          </div>
                          <span className="text-[11px] font-bold text-white/60 uppercase tracking-widest">Ready</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 옵션 설정 */}
                  {state.installHangul && (
                    <div className="space-y-4 pt-2">
                      <label className="block text-[13px] font-bold uppercase tracking-wider">옵션 설정</label>
                      <div className="space-y-3">
                        <Checkbox
                          checked={btSelected}
                          onChange={setBtSelected}
                          label="블루투스 도우미 함께 설치"
                          description="한글 입력 엔진과 블루투스 도우미를 한번에 설치합니다."
                        />
                        <Checkbox
                          checked={swapCaps}
                          onChange={setSwapCaps}
                          label="Caps Lock / Left Ctrl 스왑"
                          description="키보드 왼쪽 Caps Lock과 Ctrl 키의 위치를 서로 바꿉니다."
                        />
                      </div>
                    </div>
                  )}

                  {/* 최종 확인 사항 */}
                  <div className="space-y-4 pt-2">
                    <label className="block text-[13px] font-bold uppercase tracking-wider">최종 확인 (필수)</label>
                    <div className="space-y-3">
                      <Checkbox
                        checked={developerModeEnabled}
                        onChange={setDeveloperModeEnabled}
                        label="개발자 모드 활성화 확인"
                        description="Settings > General > Help > Copyrights > GPL > Developer Mode"
                      />
                      <Checkbox
                        checked={lockPasswordDisabled}
                        onChange={setLockPasswordDisabled}
                        label="잠금 비밀번호 해제 확인"
                        description="Settings > Security > Passcode (설치 중에는 꺼두어야 합니다)"
                      />
                    </div>
                  </div>

                  <Button
                    onClick={startInstall}
                    disabled={!developerModeEnabled || !lockPasswordDisabled}
                    size="lg"
                    className="w-full font-bold"
                  >
                    설치 시작
                  </Button>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* 설치 진행 중/완료 */}
                  <div className="text-center space-y-2 py-2">
                    <div className="flex items-center justify-center gap-1.5 text-[22px] font-bold">
                      <span>{currentStep || (status === "complete" ? "설치 완료" : "준비 중")}</span>
                      {status === "installing" && (
                        <span className="flex gap-1 ml-1">
                          <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
                          <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
                          <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
                        </span>
                      )}
                    </div>
                    <p className="text-[15px] font-medium text-muted">
                      {status === "installing" ? "기기에 필요한 파일과 설정을 적용하고 있습니다." : 
                       status === "complete" ? "모든 설치 과정이 끝났습니다." : "설치 중 오류가 발생했습니다."}
                    </p>
                  </div>

                  <ProgressBar
                    progress={progress}
                    status={status === "error" ? "error" : status === "complete" ? "complete" : "active"}
                  />

                  <div className="pt-2">
                    <TerminalOutput
                      lines={logs}
                      maxHeight="200px"
                      title="Install Log"
                      showDownload={status === "complete" || status === "error"}
                      onDownload={() => {
                        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
                        const content = `=== REKOIT 설치 로그 ===\n기기: ${state.deviceModel}\nIP: ${state.ip}\n상태: ${status}\n\n${logs.join("\n")}`;
                        const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${logFilePrefix}-${timestamp}.txt`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    />
                  </div>

                  {status === "error" && (
                    <div className="space-y-4">
                      <ErrorReport errors={errors} allLogs={logs} context={errorContext} />
                      <Button variant="secondary" onClick={startInstall} className="w-full">
                        재시도
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 하단 네비게이션 */}
        <div className="flex justify-between pt-6 stagger-2">
          <Button
            variant="ghost"
            onClick={() => router.push("/entry")}
            disabled={status === "installing"}
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>}
          >
            이전
          </Button>

          <Button
            onClick={handleNext}
            disabled={status !== "complete"}
            size="lg"
            className="font-bold"
          >
            {shouldConfigureBluetoothAfterInstall ? "블루투스 페어링 단계로" : "완료 화면으로"}
          </Button>
        </div>
      </div>
    </div>
  );
}
