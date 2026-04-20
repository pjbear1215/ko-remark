"use client";

import { useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Button from "@/components/Button";
import ProgressBar from "@/components/ProgressBar";
import TerminalOutput from "@/components/TerminalOutput";
import ErrorReport from "@/components/ErrorReport";
import { useSetup } from "@/lib/store";
import { ensureSshSession } from "@/lib/client/sshSession";

type UninstallStatus = "ready" | "uninstalling" | "complete" | "error";

export default function UninstallPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state } = useSetup();
  const returnPath = state.ip && state.password ? "/entry" : "/";
  const [status, setStatus] = useState<UninstallStatus>("ready");
  const [logs, setLogs] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState("");
  const cleanupFiles = true;
  const targetParam = searchParams.get("target");
  const removeTarget = targetParam === "hangul" || targetParam === "bt" ? targetParam : "all";
  const isPartialRemove = removeTarget !== "all";
  const [detected, setDetected] = useState<{
    hangul: boolean;
    bt: boolean;
    factoryGuard: boolean;
    swupdateHook: boolean;
  } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const statusRef = useRef<UninstallStatus>("ready");

  const pageTitle = isPartialRemove
    ? removeTarget === "hangul"
      ? "한글 입력 엔진 제거"
      : "블루투스 도우미 제거"
    : "전체 원상복구";
  const pageDescription = isPartialRemove
    ? removeTarget === "hangul"
      ? "한글 입력 엔진 관련 항목만 제거하고 블루투스 도우미 관련 구성과 한글 폰트는 유지합니다."
      : "블루투스 도우미 관련 항목만 제거하고 한글 입력 엔진 구성과 한글 폰트는 유지합니다."
    : "설치된 한글 입력 엔진/블루투스 도우미를 모두 제거하고 원본 상태로 복원합니다. (한글 폰트는 유지됩니다.)";
  const readyGuideTitle = isPartialRemove ? "부분 제거 안내" : "복구 작업 안내";
  const completeMessage = isPartialRemove
    ? removeTarget === "hangul"
      ? "한글 입력 엔진 제거가 완료되었습니다. 한글 폰트는 기기에 유지되어 있습니다."
      : "블루투스 도우미 제거가 완료되었습니다."
    : "전체 원상복구가 완료되었습니다. 한글 폰트는 기기에 유지되어 있습니다.";
  const errorContext = isPartialRemove ? "부분 제거" : "원상복구";
  const startLabel = isPartialRemove ? "제거 시작" : "제거 시작";

  const startUninstall = async (): Promise<void> => {
    statusRef.current = "uninstalling";
    setStatus("uninstalling");
    setLogs([]);
    setErrors([]);
    setProgress(0);

    try {
      await ensureSshSession(state.ip, state.password);
    } catch {
      statusRef.current = "error";
      setStatus("error");
      setLogs(["ERROR: SSH 세션을 준비할 수 없습니다."]);
      setErrors(["SSH 세션을 준비할 수 없습니다."]);
      return;
    }

    if (isPartialRemove) {
      setCurrentStep(removeTarget === "hangul" ? "한글 입력 엔진 제거" : "블루투스 도우미 제거");
      setProgress(20);
      try {
        const res = await fetch("/api/manage/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ip: state.ip, password: state.password, target: removeTarget }),
        });
        const data = await res.json();
        const nextLogs = Array.isArray(data.logs) ? data.logs : [];
        setLogs(nextLogs);

        if (!res.ok || data.success !== true) {
          const message = data.error ?? "제거 중 오류가 발생했습니다.";
          const errLine = `ERROR: ${message}`;
          setErrors([errLine]);
          setLogs((prev) => [...prev, errLine]);
          statusRef.current = "error";
          setStatus("error");
          setProgress(100);
          return;
        }

        setProgress(100);
        statusRef.current = "complete";
        setStatus("complete");
      } catch {
        const errLine = "ERROR: 제거 요청 중 서버 오류가 발생했습니다.";
        setErrors([errLine]);
        setLogs([errLine]);
        statusRef.current = "error";
        setStatus("error");
      }
      return;
    }

    const params = new URLSearchParams({
      cleanup: String(cleanupFiles),
      deleteFont: "true",
    });

    const es = new EventSource(`/api/uninstall/stream?${params}`);
    eventSourceRef.current = es;

    es.addEventListener("detect", (e) => {
      const data = JSON.parse(e.data);
      setDetected(data);
    });

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
      statusRef.current = "complete";
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
        setLogs((prev) => [...prev, "ERROR: 연결이 끊어졌습니다."]);
        setErrors((prev) => [...prev, "연결이 끊어졌습니다."]);
      }
      statusRef.current = "error";
      setStatus("error");
      es.close();
    });

    es.onerror = () => {
      if (statusRef.current === "uninstalling") {
        statusRef.current = "error";
        setStatus("error");
        setLogs((prev) => [...prev, "ERROR: SSE 연결이 끊어졌습니다."]);
        setErrors((prev) => [...prev, "SSE 연결이 끊어졌습니다."]);
      }
      es.close();
    };
  };

  return (
    <div className="animate-fade-in-up">
      <div className="space-y-6">
        <div>
          <h1
            className="text-[32px] font-bold tracking-tight"
            style={{ color: "#000000" }}
          >
            {pageTitle}
          </h1>
          <p className="text-[15px] mt-2 font-medium" style={{ color: "#666666" }}>
            {pageDescription}
          </p>
        </div>

        <div className="stagger-1">
          <div className="space-y-8">
            {/* 경고 */}
              {status === "ready" && (
                <div className="space-y-4">
                  <div
                    className="rounded-none animate-fade-in-up"
                    style={{
                      backgroundColor: "#f6f6f6",
                      padding: "20px 24px",
                      borderLeft: "4px solid #000000",
                      borderTop: "1.5px solid #000000",
                      borderRight: "1.5px solid #000000",
                      borderBottom: "1.5px solid #000000",
                    }}
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-[18px]">⚠️</span>
                      <p className="text-[16px] font-bold" style={{ color: "#000000" }}>
                        {readyGuideTitle}
                      </p>
                    </div>
                    <ul className="space-y-2.5 text-[15px]" style={{ color: "#333333" }}>
                      {(isPartialRemove ? [
                        "선택한 기능에 해당하는 항목만 제거합니다",
                        "다른 기능이 남아 있으면 공통 복구 경로는 유지됩니다",
                        "REKOIT 디렉토리 안의 해당 기능 관련 파일도 함께 정리됩니다"
                      ] : [
                        "설치된 항목을 자동 감지하여 해당 항목만 복구합니다",
                        "양쪽 파티션(현재 + 비활성) 모두 정리됩니다",
                        "펌웨어 업데이트 보호 장치도 함께 제거됩니다",
                        "한글 폰트는 기기에 유지됩니다"
                      ]).map((text, i) => (
                        <li key={i} className="flex items-start gap-3">
                          <span className="mt-2 w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                          <span className="font-medium">{text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* 진행 */}
              {status !== "ready" && (
                <div className="space-y-8 py-4 animate-fade-in">
                  <div className="text-center space-y-2">
                    <div className="flex items-center justify-center gap-1.5 text-[22px] font-bold text-black">
                      <span>{currentStep || (status === "complete" ? "제거 완료" : "준비 중")}</span>
                      {status === "uninstalling" && (
                        <span className="flex gap-1 ml-1">
                          <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
                          <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
                          <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
                        </span>
                      )}
                    </div>
                    <p className="text-[15px] font-medium opacity-50">
                      {status === "uninstalling" ? "기기를 원본 상태로 되돌리고 있습니다." : 
                       status === "complete" ? "모든 과정이 성공적으로 끝났습니다." : "오류가 발생했습니다."}
                    </p>
                  </div>
                  <div className="w-full">
                    <ProgressBar
                      progress={progress}
                      status={status === "error" ? "error" : status === "complete" ? "complete" : "active"}
                    />
                  </div>
                  <div className="pt-4 border-t border-black/5">
                    <TerminalOutput
                      lines={logs}
                      maxHeight="240px"
                      title="Uninstall Log"
                      showDownload={status === "complete" || status === "error"}
                      onDownload={() => {
                        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
                        const content = `=== REKOIT 제거 로그 ===\n기기: ${state.deviceModel}\nIP: ${state.ip}\n상태: ${status}\n\n${logs.join("\n")}`;
                        const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `rekoit-uninstall-${timestamp}.txt`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    />
                  </div>
                </div>
              )}

              {/* 완료 */}
              {status === "complete" && (
                <div
                  className="p-8 bg-[#e6f4ea] border border-[#1e8e3e] animate-scale-in"
                >
                  <p className="text-[20px] font-bold text-center" style={{ color: "#1e8e3e" }}>{completeMessage}</p>
                  {!isPartialRemove && detected && (
                    <div className="mt-2 text-[15px] text-center font-medium opacity-60">
                      {detected.hangul && detected.bt
                        ? "한글 입력 엔진과 블루투스 도우미 설치가 모두 정리됨"
                        : detected.hangul
                        ? "한글 입력 엔진 구성이 정리됨"
                        : detected.bt
                        ? "블루투스 도우미 설치가 정리됨"
                        : "설치된 항목 없음"}
                    </div>
                  )}
                </div>
              )}

              {status === "complete" && errors.length > 0 && (
                <ErrorReport errors={errors} allLogs={logs} context={errorContext} />
              )}

              {/* 에러 */}
              {status === "error" && (
                <div className="space-y-4">
                  <div
                    className="p-6 bg-[#fce8e6] border border-[#d93025] animate-fade-in"
                  >
                    <p className="text-[17px] font-bold" style={{ color: "#d93025" }}>오류가 발생했습니다.</p>
                  </div>
                  <ErrorReport errors={errors} allLogs={logs} context={errorContext} />
                  <Button variant="primary" onClick={startUninstall} className="font-bold">
                    재시도
                  </Button>
                </div>
              )}
          </div>
        </div>

        {/* 네비게이션 */}
        <div className="flex justify-between pt-8 stagger-2">
          <Button variant="ghost" onClick={() => router.push(returnPath)} disabled={status === "uninstalling"} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6" /></svg>}>
            작업 선택으로
          </Button>
          {status === "ready" ? (
            <Button onClick={startUninstall} size="lg" className="px-16 font-bold">
              {startLabel}
            </Button>
          ) : status === "complete" ? (
            <Button onClick={() => router.push(returnPath)} size="lg" className="px-16 font-bold" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6" /></svg>}>
              작업 선택으로
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
