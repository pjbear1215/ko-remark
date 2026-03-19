"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/Button";
import ProgressBar from "@/components/ProgressBar";
import TerminalOutput from "@/components/TerminalOutput";
import ErrorReport from "@/components/ErrorReport";
import { useSetup } from "@/lib/store";
import { ensureSshSession } from "@/lib/client/sshSession";

type UninstallStatus = "ready" | "uninstalling" | "complete" | "error";

export default function UninstallPage() {
  const router = useRouter();
  const { state } = useSetup();
  const [status, setStatus] = useState<UninstallStatus>("ready");
  const [logs, setLogs] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState("");
  const cleanupFiles = true;
  const [detected, setDetected] = useState<{
    keypad: boolean;
    bt: boolean;
    factoryGuard: boolean;
    swupdateHook: boolean;
  } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const statusRef = useRef<UninstallStatus>("ready");

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
              설치제거
            </h1>
            <p
              className="mt-3 text-[17px]"
              style={{ color: "var(--text-muted)" }}
            >
              한글 입력 관련 설정을 모두 제거하고 원본 상태로 복원합니다.
            </p>
          </div>
          <Button variant="ghost" onClick={() => router.push("/")} disabled={status === "uninstalling"}>
            처음으로
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
                복구 작업 안내
              </p>
              <ul className="mt-3 space-y-1.5 text-[15px]" style={{ color: "var(--text-muted)" }}>
                <li>설치된 항목을 자동 감지하여 해당 항목만 복구합니다</li>
                <li>xochitl 바이너리는 백업해둔 원본으로 복원됩니다</li>
                <li>양쪽 파티션(현재 + 비활성) 모두 정리됩니다</li>
                <li>펌웨어 업데이트 보호 장치도 함께 제거됩니다</li>
                <li>한글 폰트도 함께 삭제됩니다</li>
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
            <p className="text-[20px] font-medium text-center">설치제거가 완료되었습니다.</p>
            {detected && (
              <div className="mt-3 text-[14px] text-center" style={{ color: "var(--text-muted)" }}>
                {detected.keypad && detected.bt
                  ? "기존 설치 상태와 블루투스 구성이 모두 정리됨"
                  : detected.keypad
                  ? "기존 설치 상태가 정리됨"
                  : detected.bt
                  ? "블루투스 키보드 복구됨"
                  : "설치된 항목 없음"}
              </div>
            )}
          </div>
        )}

        {status === "complete" && errors.length > 0 && (
          <ErrorReport errors={errors} allLogs={logs} context="원상복구" />
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
            <ErrorReport errors={errors} allLogs={logs} context="원상복구" />
            <Button variant="secondary" onClick={startUninstall}>
              재시도
            </Button>
          </div>
        )}

        {/* 네비게이션 */}
        <div className="flex justify-end pt-4">
          {status === "ready" ? (
            <Button onClick={startUninstall} size="lg">
              제거시작
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
