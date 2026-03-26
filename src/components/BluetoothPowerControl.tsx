"use client";

import { useCallback, useEffect, useState } from "react";

import Button from "@/components/Button";

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
  const [result, setResult] = useState<string | null>(null);

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

    try {
      for (let attempt = 0; attempt < retries; attempt++) {
        const data = await postJsonWithTimeout("/api/bluetooth/status", { ip, password }, 15000);
        if (data.success) {
          setActive(Boolean(data.active));
          setPowered(Boolean(data.powered));
          return;
        }

        const message = String(data.error ?? "");
        const transient = message.includes("Permission denied") || message.includes("timeout");
        if (!transient || attempt === retries - 1) {
          if (!silent) {
            setResult(`상태 읽기 실패: ${data.error ?? "알 수 없는 오류"}`);
          }
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch {
      if (!silent) {
        setResult("상태 읽기 실패: 서버 오류");
      }
    } finally {
      setLoading(false);
    }
  }, [ip, password, postJsonWithTimeout]);

  useEffect(() => {
    void loadStatus({ retries: 4 });
  }, [loadStatus]);

  const applyPower = async (action: "on" | "off") => {
    setSavingAction(action);
    setResult(null);
    try {
      const data = await postJsonWithTimeout("/api/bluetooth/power", { ip, password, action }, 20000);
      if (data.success) {
        setActive(Boolean(data.active));
        setPowered(Boolean(data.powered));
        setResult(action === "on" ? "활성화됨" : "비활성화됨");
      } else {
        setResult(`실패: ${data.error ?? "알 수 없는 오류"}`);
      }
    } catch {
      setResult("서버 오류");
    } finally {
      setSavingAction(null);
      void loadStatus({ silent: true, retries: 2 });
    }
  };

  const isOn = active && powered;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div
        className="card-interactive flex items-center justify-between"
        style={{ padding: "20px 24px" }}
      >
        <div>
          <p className="text-[16px] font-medium" style={{ color: "var(--text-primary)" }}>
            블루투스 전원
          </p>
          <p className="text-[14px]" style={{ color: "var(--text-muted)", marginTop: "4px" }}>
            서비스가 꺼져 있으면 꺼진 상태로 간주합니다.
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            variant={isOn ? "secondary" : "ghost"}
            size="sm"
            onClick={() => applyPower("on")}
            loading={savingAction === "on"}
            disabled={savingAction !== null}
          >
            켜기
          </Button>
          <Button
            variant={!isOn ? "secondary" : "ghost"}
            size="sm"
            onClick={() => applyPower("off")}
            loading={savingAction === "off"}
            disabled={savingAction !== null}
          >
            끄기
          </Button>
        </div>
      </div>
      {!loading && (
        <p className="text-[14px]" style={{ color: "var(--text-muted)", paddingLeft: "4px" }}>
          현재 상태: {isOn ? "켜짐" : active ? "서비스만 실행 중" : "꺼짐"}
        </p>
      )}
      {result && (
        <p
          className="text-[14px] animate-fade-in"
          style={{
            color:
              result.startsWith("실패") || result.startsWith("상태 읽기 실패")
                ? "var(--error)"
                : "var(--success)",
            paddingLeft: "4px",
          }}
        >
          {result}
        </p>
      )}
    </div>
  );
}
