"use client";

import { useCallback, useEffect, useState } from "react";

import Button from "@/components/Button";
import TerminalOutput from "@/components/TerminalOutput";

interface BluetoothPowerControlProps {
  ip: string;
  password: string;
}

export default function BluetoothPowerControl({
  ip,
  password,
}: BluetoothPowerControlProps) {
  const [loading, setLoading] = useState(false);
  const [savingAction, setSavingAction] = useState<"on" | "off" | null>(null);
  const [active, setActive] = useState(false);
  const [powered, setPowered] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${timestamp}] ${message}`]);
  }, []);

  const postJsonWithTimeout = useCallback(
    async (url: string, body: Record<string, unknown>, timeoutMs: number) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        return await res.json();
      } finally {
        clearTimeout(timeout);
      }
    },
    [],
  );

  const loadStatus = useCallback(async (options?: { silent?: boolean; retries?: number }) => {
    if (!ip || !password) {
      return;
    }

    setLoading(true);
    const silent = options?.silent ?? false;
    const retries = options?.retries ?? 1;

    if (!silent) addLog("블루투스 상태 확인 중...");

    try {
      for (let attempt = 0; attempt < retries; attempt++) {
        const data = await postJsonWithTimeout("/api/bluetooth/status", { ip, password }, 15000);
        if (data.success) {
          setActive(Boolean(data.active));
          setPowered(Boolean(data.powered));
          if (!silent) {
            addLog(`상태 확인 성공: ${data.active && data.powered ? "켜짐" : data.active ? "서비스만 실행 중" : "꺼짐"}`);
          }
          return;
        }

        const message = String(data.error ?? "");
        const transient = message.includes("Permission denied") || message.includes("timeout");
        if (!transient || attempt === retries - 1) {
          if (!silent) {
            addLog(`ERROR: 상태 읽기 실패: ${data.error ?? "알 수 없는 오류"}`);
          }
          return;
        }

        if (!silent) addLog(`경고: 연결 재시도 중... (${attempt + 1}/${retries})`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (e) {
      if (!silent) {
        addLog(`ERROR: 서버 오류 발생: ${e instanceof Error ? e.message : "알 수 없음"}`);
      }
    } finally {
      setLoading(false);
    }
  }, [ip, password, postJsonWithTimeout, addLog]);

  useEffect(() => {
    void loadStatus({ retries: 4 });
  }, [loadStatus]);

  const applyPower = async (action: "on" | "off") => {
    setSavingAction(action);
    addLog(`블루투스 전원 ${action === "on" ? "켜기" : "끄기"} 시도 중...`);
    try {
      const data = await postJsonWithTimeout("/api/bluetooth/power", { ip, password, action }, 20000);
      if (data.success) {
        setActive(Boolean(data.active));
        setPowered(Boolean(data.powered));
        addLog(`OK: 전원 ${action === "on" ? "활성화됨" : "비활성화됨"}`);
      } else {
        addLog(`FAIL: 전원 변경 실패: ${data.error ?? "알 수 없는 오류"}`);
      }
    } catch (e) {
      addLog(`ERROR: 서버 오류: ${e instanceof Error ? e.message : "알 수 없음"}`);
    } finally {
      setSavingAction(null);
      void loadStatus({ silent: true, retries: 2 });
    }
  };

  const isOn = active && powered;

  return (
    <div className="space-y-3">
      <div
        className="flex items-center justify-between p-4 bg-black/[0.03] border border-black/5"
      >
        <div>
          <p className="text-[16px] font-bold text-black">
            블루투스 전원
          </p>
          <p className="text-[13px] font-medium opacity-50 mt-0.5">
            서비스가 꺼져 있으면 꺼진 상태로 간주합니다.
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            variant={isOn ? "primary" : "ghost"}
            size="sm"
            onClick={() => applyPower("on")}
            loading={savingAction === "on"}
            disabled={savingAction !== null}
            className="font-bold"
          >
            켜기
          </Button>
          <Button
            variant={!isOn ? "primary" : "ghost"}
            size="sm"
            onClick={() => applyPower("off")}
            loading={savingAction === "off"}
            disabled={savingAction !== null}
            className="font-bold"
          >
            끄기
          </Button>
        </div>
      </div>

      <TerminalOutput
        lines={logs}
        title="Bluetooth Power Log"
        initiallyOpen={false}
        maxHeight="180px"
        showDownload={logs.length > 0}
        onDownload={() => {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const content = `=== REKOIT 블루투스 제어 로그 ===\n${logs.join("\n")}`;
          const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `rekoit-bt-power-${timestamp}.txt`;
          a.click();
          URL.revokeObjectURL(url);
        }}
      />
    </div>
  );
}
