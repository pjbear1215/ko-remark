"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
import Checkbox from "@/components/Checkbox";
import { useSetup } from "@/lib/store";
import { useGuard } from "@/lib/useGuard";

type EntryAction = "install-hangul" | "install-bt" | "manage";

export default function EntryPage() {
  const allowed = useGuard();
  const router = useRouter();
  const { state, setState } = useSetup();
  const [selectedAction, setSelectedAction] = useState<EntryAction>("install-hangul");
  const selectionTouchedRef = useRef(false);
  const [manageAvailable, setManageAvailable] = useState<boolean | null>(null);
  const [installedState, setInstalledState] = useState<{ hangul: boolean; bt: boolean }>({ hangul: false, bt: false });
  const [manageChecking, setManageChecking] = useState(true);
  const [manageCheckError, setManageCheckError] = useState<string | null>(null);
  const [eulaChecked, setEulaChecked] = useState(state.eulaAgreed);

  useEffect(() => {
    if (!allowed) return;

    let cancelled = false;

    const checkManageAvailability = async () => {
      setManageChecking(true);
      setManageCheckError(null);
      try {
        const res = await fetch("/api/manage/availability", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ip: state.ip, password: state.password }),
        });
        const data = await res.json();
        if (cancelled) return;
        const installed = res.ok && data.installed === true;
        setManageAvailable(installed);
        setInstalledState({
          hangul: res.ok && data.hangulInstalled === true,
          bt: res.ok && data.btInstalled === true,
        });
        if (!selectionTouchedRef.current) {
          setSelectedAction(installed ? "manage" : "install-hangul");
        }
        if (!res.ok && data.error) {
          setManageCheckError("설정 변경 가능 여부를 확인하지 못했습니다.");
        }
      } catch {
        if (cancelled) return;
        setManageAvailable(false);
        setInstalledState({ hangul: false, bt: false });
        setManageCheckError("설정 변경 가능 여부를 확인하지 못했습니다.");
        if (!selectionTouchedRef.current) {
          setSelectedAction("install-hangul");
        }
      } finally {
        if (!cancelled) {
          setManageChecking(false);
        }
      }
    };

    void checkManageAvailability();

    return () => {
      cancelled = true;
    };
  }, [allowed, state.ip, state.password]);

  if (!allowed) return null;

  const canManage = manageAvailable === true;
  const isInstallAction = selectedAction === "install-hangul" || selectedAction === "install-bt";
  const actionCards = [
    {
      id: "install-hangul" as const,
      title: installedState.hangul ? "한글 입력 재설치" : "한글 입력 설치",
      description: installedState.hangul
        ? "한글 폰트와 입력 런타임을 다시 적용합니다. 설치 과정에서 블루투스 설치를 함께 선택할 수 있습니다."
        : "Type Folio를 포함한 한글 입력을 설치합니다. 필요하면 블루투스 설치도 함께 적용할 수 있습니다.",
      disabled: false,
    },
    {
      id: "install-bt" as const,
      title: installedState.bt ? "블루투스 재설치" : "블루투스 설치",
      description: "한글 입력 없이 블루투스 키보드 연결 경로만 준비합니다.",
      disabled: false,
    },
    {
      id: "manage" as const,
      title: "기기 관리",
      description: "다시 설치하지 않고 블루투스 재페어링, 전원 제어, 키보드 설정만 바꿉니다.",
      disabled: !canManage,
    },
  ];

  const nextLabel = selectedAction === "install-hangul"
    ? "한글 입력 설치로"
    : selectedAction === "install-bt"
      ? "블루투스 설치로"
      : "기기 관리로";

  const handleNext = () => {
    if (selectedAction === "manage") {
      setState({ eulaAgreed: state.eulaAgreed });
      router.push("/manage");
      return;
    }

    setState({
      eulaAgreed: eulaChecked,
      installHangul: selectedAction === "install-hangul",
      installBtKeyboard: selectedAction === "install-bt",
    });
    router.push("/install");
  };

  return (
    <div className="animate-fade-in-up">
      <StepIndicator currentStep={3} />

      <div className="space-y-10">
        <div>
          <h1
            className="text-[36px] font-bold leading-tight"
            style={{ color: "var(--text-primary)" }}
          >
            작업 선택
          </h1>
          <p
            className="mt-3 text-[17px]"
            style={{ color: "var(--text-muted)" }}
          >
            연결된 기기에서 진행할 작업을 선택하세요.
          </p>
        </div>

        <div className="space-y-5 stagger-1">
          <div className="grid gap-3 md:grid-cols-3">
            {actionCards.map((action) => {
              const selected = selectedAction === action.id;
              const disabled = action.disabled;
              return (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => {
                    if (!disabled) {
                      selectionTouchedRef.current = true;
                      setSelectedAction(action.id);
                    }
                  }}
                  disabled={disabled}
                  className="text-left rounded-xl transition-all disabled:cursor-not-allowed"
                  style={{
                    backgroundColor: selected ? "var(--bg-card)" : "var(--bg-secondary)",
                    border: selected ? "2px solid var(--accent)" : "1px solid var(--border-light)",
                    padding: "20px 24px",
                    boxShadow: selected ? "var(--shadow-sm)" : "none",
                    opacity: disabled ? 0.55 : 1,
                  }}
                >
                  <p className="text-[18px] font-semibold" style={{ color: "var(--text-primary)" }}>
                    {action.title}
                  </p>
                  <p className="text-[14px] mt-2" style={{ color: "var(--text-muted)" }}>
                    {disabled
                      ? manageChecking
                        ? "기기 관리 가능 여부를 확인하고 있습니다."
                        : "이미 설치된 한글 입력 또는 블루투스 설치가 있을 때만 사용할 수 있습니다."
                      : action.description}
                  </p>
                </button>
              );
            })}
          </div>

          {manageCheckError && (
            <p className="text-[14px] animate-fade-in" style={{ color: "var(--warning)" }}>
              {manageCheckError}
            </p>
          )}
        </div>

        {isInstallAction && (
          <div className="space-y-4 stagger-2">
            <div
              className="p-6 rounded-xl text-[13px] leading-[22px] overflow-auto"
              style={{
                backgroundColor: "var(--bg-secondary)",
                maxHeight: "240px",
                color: "var(--text-muted)",
              }}
            >
              <p className="font-semibold text-[14px] mb-3" style={{ color: "var(--text-primary)" }}>
                설치 전 확인
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>현재는 Type Folio와 블루투스 키보드용 한글 입력만 지원합니다.</li>
                <li>기존 설치 상태가 남아 있다면 원상복구 후 다시 진행하세요.</li>
                <li>전체 원상복구 기능으로 원본 상태로 되돌릴 수 있습니다.</li>
              </ul>
              <p className="mt-3 text-[12px]" style={{ color: "var(--border)" }}>
                English: This tool is provided &quot;AS IS&quot; without warranty of any kind.
                It is not affiliated with reMarkable AS. You are solely responsible for any changes made to your own device.
              </p>
            </div>
            <Checkbox
              checked={eulaChecked}
              onChange={setEulaChecked}
              label="위 내용을 읽었고, 제 기기에 적용되는 모든 변경의 책임이 본인에게 있음을 이해했습니다. / I understand that I am solely responsible for any changes made to my device."
            />
          </div>
        )}

        <div className="flex justify-between pt-4 stagger-3">
          <Button variant="ghost" onClick={() => router.push("/connection")}>
            이전
          </Button>
          <Button
            onClick={handleNext}
            disabled={manageChecking || (!isInstallAction && !canManage) || (isInstallAction && !eulaChecked)}
            size="lg"
          >
            {nextLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
