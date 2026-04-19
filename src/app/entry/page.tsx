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
      title: installedState.hangul ? "한글 입력 엔진 재설치" : "한글 입력 엔진 설치",
      description: "한글 입력 엔진을 설치합니다. 필요하면 블루투스 도우미도 함께 설치 가능합니다.",
      disabled: false,
    },
    {
      id: "install-bt" as const,
      title: installedState.bt ? "블루투스 도우미 재설치" : "블루투스 도우미 설치",
      description: "블루투스 도우미를 설치합니다. 한글 입력 엔진을 설치하지 않을 경우, 영문 입력만 가능합니다.",
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
    ? "한글 입력 엔진 설치로"
    : selectedAction === "install-bt"
      ? "블루투스 도우미 설치로"
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

      <div className="space-y-8">
        <div>
          <h1
            className="text-[32px] font-bold tracking-tight"
            style={{ color: "var(--text-primary)" }}
          >
            작업 선택
          </h1>
          <p
            className="mt-2 text-[15px] font-medium"
            style={{ color: "var(--text-muted)" }}
          >
            설치 또는 기기 관리를 시작하기 위해 작업을 선택하세요.
          </p>
        </div>

        <div className="space-y-5 stagger-1">
          <div className="grid gap-y-6 gap-x-2 md:grid-cols-3">
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
                    backgroundColor: selected ? "#000000" : "var(--bg-secondary)",
                    border: selected ? "2px solid #000000" : "1.5px solid var(--border-light)",
                    padding: "18px 20px",
                    boxShadow: selected ? "0 8px 20px rgba(0,0,0,0.12)" : "none",
                    opacity: disabled ? 0.55 : 1,
                    transform: selected ? "translateY(-2px)" : "none",
                  }}
                >
                  <p className="text-[18px] font-semibold" style={{ color: selected ? "#ffffff" : "var(--text-primary)" }}>
                    {action.title}
                  </p>
                  <p className="text-[14px] mt-2" style={{ color: selected ? "rgba(255,255,255,0.8)" : "var(--text-muted)" }}>
                    {disabled
                      ? manageChecking
                        ? "기기 관리 가능 여부를 확인하고 있습니다."
                        : "이미 설치된 한글 입력 엔진 또는 블루투스 도우미가 있을 때만 사용할 수 있습니다."
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
              className="rounded-none"
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
                  설치 전 확인
                </p>
              </div>
              <ul className="space-y-2 text-[15px]" style={{ color: "#333333" }}>
                <li className="flex items-start gap-3">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                  <span className="font-medium">
                    설치되는 모든 구성 요소는 <strong>시스템 바이너리(xochitl) 및 라이브러리(libepaper.so 등) 파일을 수정하지 않습니다.</strong>
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                  <span className="font-medium">
                    한글 입력 엔진은 <strong>입력 신호를 가로채 메모리 상에서 한글 조합을 생성</strong>하고, 확정된 조합을 <strong>키 맵핑 변경을 통해 출력</strong>합니다.
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                  <span className="font-medium">
                    키 맵핑 과정에서 <strong>tmpfs mount를 활용</strong>하여 원본 경로에 <strong>임시로 덮어씌우는 방식</strong>을 사용하므로, 원본 파일을 직접 수정하지 않으며 맵핑 정보가 영구적으로 저장되지 않아 안전합니다.
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                  <span className="font-medium">
                    한글 입력 엔진은 <strong>Type Folio와 일부 블루투스 키보드</strong>에서만 검증되었습니다.
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                  <span className="font-medium">
                    Type Folio만 사용하는 경우에는 <strong>한글 입력 엔진만 설치</strong>해도 충분합니다.
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                  <span className="font-medium">기존 설치 상태가 남아 있다면 원상복구 후 다시 진행하세요.</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                  <span className="font-medium">전체 원상복구 기능으로 원본 상태로 되돌릴 수 있습니다.</span>
                </li>
              </ul>
            </div>
            <Checkbox
              checked={eulaChecked}
              onChange={setEulaChecked}
              label="상기 유의사항을 모두 숙지하였으며, 기기 변경 및 결과에 대한 책임이 사용자 본인에게 있음을 확인하고 동의합니다."
            />
          </div>
        )}

        <div className="flex justify-between pt-4 stagger-3">
          <Button
            variant="ghost"
            onClick={() => router.push("/")}
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>}
          >
            처음으로
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
