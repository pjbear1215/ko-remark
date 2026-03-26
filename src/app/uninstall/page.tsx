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
      ? "한글 입력 제거"
      : "블루투스 제거"
    : "설치제거";
  const pageDescription = isPartialRemove
    ? removeTarget === "hangul"
      ? "한글 입력 관련 항목만 제거하고 블루투스 관련 구성은 유지합니다."
      : "블루투스 관련 항목만 제거하고 한글 입력 구성은 유지합니다."
    : "설치된 한글 입력/블루투스 설치를 모두 제거하고 원본 상태로 복원합니다.";
  const readyGuideTitle = isPartialRemove ? "부분 제거 안내" : "복구 작업 안내";
  const completeMessage = isPartialRemove
    ? removeTarget === "hangul"
      ? "한글 입력 제거가 완료되었습니다."
      : "블루투스 제거가 완료되었습니다."
    : "설치제거가 완료되었습니다.";
  const errorContext = isPartialRemove ? "부분 제거" : "원상복구";
  const startLabel = isPartialRemove ? "제거시작" : "제거시작";

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
      setCurrentStep(removeTarget === "hangul" ? "한글 입력 제거" : "블루투스 제거");
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
      <div className="space-y-10">
        <div className="flex items-start justify-between">
          <div>
            <h1
              className="text-[36px] font-bold leading-tight"
              style={{ color: "var(--text-primary)" }}
            >
              {pageTitle}
            </h1>
          <p
            className="mt-3 text-[17px]"
            style={{ color: "var(--text-muted)" }}
          >
            {pageDescription}
          </p>
          </div>
          <Button variant="ghost" onClick={() => router.push(returnPath)} disabled={status === "uninstalling"}>
            작업 선택으로
          </Button>
        </div>

        {/* 경고 */}
        {status === "ready" && (
          <div className="space-y-4">
            <div
              className="p-6 rounded-xl animate-fade-in-up stagger-1"
              style={{ backgroundColor: "var(--warning-light)", border: "1px solid var(--warning)" }}
            >
              <p className="font-medium text-[17px]" style={{ color: "var(--text-primary)" }}>
                {readyGuideTitle}
              </p>
              <ul className="mt-3 space-y-1.5 text-[15px]" style={{ color: "var(--text-muted)" }}>
                {isPartialRemove ? (
                  <>
                    <li>선택한 기능에 해당하는 항목만 제거합니다</li>
                    <li>다른 기능이 남아 있으면 공통 복구 경로는 유지됩니다</li>
                    <li>ReKoIt 디렉토리 안의 해당 기능 관련 파일도 함께 정리됩니다</li>
                  </>
                ) : (
                  <>
                    <li>설치된 항목을 자동 감지하여 해당 항목만 복구합니다</li>
                    <li>양쪽 파티션(현재 + 비활성) 모두 정리됩니다</li>
                    <li>펌웨어 업데이트 보호 장치도 함께 제거됩니다</li>
                    <li>한글 폰트도 함께 삭제됩니다</li>
                  </>
                )}
              </ul>
            </div>
          </div>
        )}

        {/* 진행 */}
        {status !== "ready" && (
          <div className="space-y-4 animate-fade-in-up stagger-1">
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
            className="p-6 rounded-xl animate-fade-in"
            style={{ backgroundColor: "var(--success-light)", color: "var(--success)" }}
          >
            <p className="text-[20px] font-medium text-center">{completeMessage}</p>
            {!isPartialRemove && detected && (
              <div className="mt-3 text-[14px] text-center" style={{ color: "var(--text-muted)" }}>
                {detected.hangul && detected.bt
                  ? "한글 입력과 블루투스 설치가 모두 정리됨"
                  : detected.hangul
                  ? "한글 입력 구성이 정리됨"
                  : detected.bt
                  ? "블루투스 설치가 정리됨"
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
              className="p-6 rounded-xl animate-fade-in"
              style={{ backgroundColor: "var(--error-light)", color: "var(--error)" }}
            >
              <p className="text-[17px] font-medium">오류가 발생했습니다.</p>
            </div>
            <ErrorReport errors={errors} allLogs={logs} context={errorContext} />
            <Button variant="secondary" onClick={startUninstall}>
              재시도
            </Button>
          </div>
        )}

        {/* 네비게이션 */}
        <div className="flex justify-end pt-4">
          {status === "ready" ? (
            <Button onClick={startUninstall} size="lg">
              {startLabel}
            </Button>
          ) : status === "complete" ? (
            <Button onClick={() => router.push(returnPath)} size="lg">
              작업 선택으로
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
