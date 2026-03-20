"use client";

import { useEffect, useState } from "react";

import Button from "@/components/Button";
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
  const [result, setResult] = useState<string | null>(null);
  const [swapLeftCtrlCapsLock, setSwapLeftCtrlCapsLock] = useState(state.swapLeftCtrlCapsLock);

  useEffect(() => {
    setSwapLeftCtrlCapsLock(state.swapLeftCtrlCapsLock);
  }, [state.swapLeftCtrlCapsLock]);

  useEffect(() => {
    if (!ip || !password) {
      return;
    }

    let cancelled = false;

    const loadKeyboardSettings = async () => {
      setLoading(true);
      setResult(null);
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
        if (cancelled) {
          return;
        }
        if (data.success) {
          const nextValue = Boolean(data.swapLeftCtrlCapsLock);
          setSwapLeftCtrlCapsLock(nextValue);
          setSetupState({ swapLeftCtrlCapsLock: nextValue });
        } else {
          setResult(`설정 읽기 실패: ${data.error ?? "알 수 없는 오류"}`);
        }
      } catch {
        if (!cancelled) {
          setResult("설정 읽기 실패: 서버 오류");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadKeyboardSettings();

    return () => {
      cancelled = true;
    };
  }, [ip, password]);

  const applySwapSetting = async (nextValue: boolean) => {
    setSavingAction(nextValue ? "on" : "off");
    setResult(null);
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
        setResult(
          data.restarted
            ? nextValue
              ? "활성화됨. hangul-daemon을 다시 시작했습니다."
              : "비활성화됨. hangul-daemon을 다시 시작했습니다."
            : nextValue
              ? "활성화됨. 다음 hangul-daemon 시작부터 적용됩니다."
              : "비활성화됨. 다음 hangul-daemon 시작부터 적용됩니다.",
        );
      } else {
        setResult(`실패: ${data.error ?? "알 수 없는 오류"}`);
      }
    } catch {
      setResult("실패: 서버 오류");
    } finally {
      setSavingAction(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div
        className="card-interactive flex items-center justify-between"
        style={{ padding: "20px 24px" }}
      >
        <div>
          <p className="text-[16px] font-medium" style={{ color: "var(--text-primary)" }}>
            왼쪽 CapsLock과 왼쪽 Ctrl 위치 바꾸기
          </p>
          <p className="text-[14px]" style={{ color: "var(--text-muted)", marginTop: "4px" }}>
            켜면 왼쪽 CapsLock은 Ctrl처럼, 왼쪽 Ctrl은 CapsLock처럼 동작합니다.
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => applySwapSetting(true)}
            loading={savingAction === "on"}
            disabled={loading || savingAction !== null}
          >
            켜기
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => applySwapSetting(false)}
            loading={savingAction === "off"}
            disabled={loading || savingAction !== null}
          >
            끄기
          </Button>
        </div>
      </div>
      {!loading && (
        <p className="text-[14px]" style={{ color: "var(--text-muted)", paddingLeft: "4px" }}>
          현재 상태: {swapLeftCtrlCapsLock ? "켜짐" : "꺼짐"}
        </p>
      )}
      {result && (
        <p
          className="text-[14px] animate-fade-in"
          style={{
            color:
              result.startsWith("실패") || result.startsWith("설정 읽기 실패")
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
