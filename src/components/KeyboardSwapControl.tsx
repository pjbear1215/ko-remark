"use client";

import { useEffect, useState, useCallback } from "react";

import Button from "@/components/Button";
import TerminalOutput from "@/components/TerminalOutput";
import { useSetup } from "@/lib/store";

interface KeyboardSwapControlProps {
  ip: string;
  password: string;
}

export default function KeyboardSwapControl({
  ip,
  password,
}: KeyboardSwapControlProps) {
  const { state, setState: setSetupState } = useSetup();
  const [loading, setLoading] = useState(false);
  const [savingAction, setSavingAction] = useState<"on" | "off" | null>(null);
  const [swapLeftCtrlCapsLock, setSwapLeftCtrlCapsLock] = useState(state.swapLeftCtrlCapsLock);
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${timestamp}] ${message}`]);
  }, []);

  useEffect(() => {
    setSwapLeftCtrlCapsLock(state.swapLeftCtrlCapsLock);
  }, [state.swapLeftCtrlCapsLock]);

  const loadKeyboardSettings = useCallback(async (options?: { silent?: boolean }) => {
    if (!ip || !password) return;

    setLoading(true);
    const silent = options?.silent ?? false;
    if (!silent) addLog("키보드 설정 읽는 중...");

    try {
      const res = await fetch("/api/manage/keyboard-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip,
          password,
          action: "get",
        }),
      });
      const data = await res.json();
      if (data.success) {
        const nextValue = Boolean(data.swapLeftCtrlCapsLock);
        setSwapLeftCtrlCapsLock(nextValue);
        setSetupState({ swapLeftCtrlCapsLock: nextValue });
        if (!silent) addLog(`설정 확인 완료: 현재 ${nextValue ? "켜짐" : "꺼짐"}`);
      } else {
        if (!silent) addLog(`ERROR: 설정 읽기 실패: ${data.error ?? "알 수 없는 오류"}`);
      }
    } catch (e) {
      if (!silent) addLog(`ERROR: 서버 오류: ${e instanceof Error ? e.message : "알 수 없음"}`);
    } finally {
      setLoading(false);
    }
  }, [ip, password, setSetupState, addLog]);

  useEffect(() => {
    void loadKeyboardSettings();
  }, [loadKeyboardSettings]);

  const applySwapSetting = async (nextValue: boolean) => {
    setSavingAction(nextValue ? "on" : "off");
    addLog(`키보드 레이아웃 변경 시도 (${nextValue ? "켜기" : "끄기"})...`);
    try {
      const res = await fetch("/api/manage/keyboard-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip,
          password,
          action: "set",
          swapLeftCtrlCapsLock: nextValue,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSwapLeftCtrlCapsLock(nextValue);
        setSetupState({ swapLeftCtrlCapsLock: nextValue });
        const msg = data.restarted
          ? `OK: ${nextValue ? "활성화" : "비활성화"}됨 (데몬 재시작 완료)`
          : `OK: ${nextValue ? "활성화" : "비활성화"}됨 (다음 시작부터 적용)`;
        addLog(msg);
      } else {
        addLog(`FAIL: 설정 변경 실패: ${data.error ?? "알 수 없는 오류"}`);
      }
    } catch (e) {
      addLog(`ERROR: 서버 오류: ${e instanceof Error ? e.message : "알 수 없음"}`);
    } finally {
      setSavingAction(null);
    }
  };

  return (
    <div className="space-y-3">
      <div
        className="flex items-center justify-between p-4 bg-black/[0.03] border border-black/5"
      >
        <div>
          <p className="text-[16px] font-bold text-black">
            왼쪽 CapsLock과 왼쪽 Ctrl 위치 바꾸기
          </p>
          <p className="text-[13px] font-medium opacity-50 mt-0.5">
            켜면 왼쪽 CapsLock은 Ctrl처럼, 왼쪽 Ctrl은 CapsLock처럼 동작합니다.
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            variant={swapLeftCtrlCapsLock ? "primary" : "ghost"}
            size="sm"
            onClick={() => applySwapSetting(true)}
            loading={savingAction === "on"}
            disabled={loading || savingAction !== null}
            aria-pressed={swapLeftCtrlCapsLock}
            className="font-bold"
          >
            켜기
          </Button>
          <Button
            variant={swapLeftCtrlCapsLock ? "ghost" : "primary"}
            size="sm"
            onClick={() => applySwapSetting(false)}
            loading={savingAction === "off"}
            disabled={loading || savingAction !== null}
            aria-pressed={!swapLeftCtrlCapsLock}
            className="font-bold"
          >
            끄기
          </Button>
        </div>
      </div>

      <TerminalOutput
        lines={logs}
        title="Keyboard Layout Log"
        initiallyOpen={false}
        maxHeight="180px"
        showDownload={logs.length > 0}
        onDownload={() => {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const content = `=== REKOIT 키보드 설정 로그 ===\n${logs.join("\n")}`;
          const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `rekoit-keyboard-log-${timestamp}.txt`;
          a.click();
          URL.revokeObjectURL(url);
        }}
      />
    </div>
  );
}
