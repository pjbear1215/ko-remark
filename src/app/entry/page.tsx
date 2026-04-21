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
          <div className="space-y-6 stagger-2">
            {/* 시스템 안내 카드 */}
            <div
              className="rounded-none border-l-4 border-black"
              style={{
                backgroundColor: "#f9f9f9",
                padding: "24px",
                borderTop: "1.5px solid #000000",
                borderRight: "1.5px solid #000000",
                borderBottom: "1.5px solid #000000",
              }}
            >
              <div className="flex items-center gap-2 mb-6">
                <span className="text-[18px]">⚠️</span>
                <p className="text-[18px] font-bold" style={{ color: "#000000" }}>
                  설치 전 확인
                </p>
              </div>
              
              <div className="space-y-6 text-[14.5px] leading-relaxed" style={{ color: "#333333" }}>
                {/* 1. 시스템 안전성 및 보증 */}
                <div>
                  <p className="font-bold text-[15px] mb-2">1. 시스템 안전성 및 보증</p>
                  <ul className="space-y-1.5 ml-1">
                    <li className="flex gap-2">
                      <span className="shrink-0">•</span>
                      <span><strong>바이너리 변조 없음:</strong> 설치되는 모든 구성 요소는 기기의 핵심 실행 파일(xochitl) 및 시스템 라이브러리(libepaper.so 등)를 직접 수정하지 않습니다.</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="shrink-0">•</span>
                      <span><strong>휘발성 맵핑 방식:</strong> 시스템 라이브러리 교체 시 tmpfs mount(메모리 오버레이) 방식을 사용합니다. 원본 파일은 그대로 보존되며, 수정된 정보는 메모리 상에만 임시로 존재하므로 시스템의 영구적인 변조가 없어 안전합니다.</span>
                    </li>
                  </ul>
                </div>

                {/* 2. 한글 입력 엔진의 원리 */}
                <div>
                  <p className="font-bold text-[15px] mb-2">2. 한글 입력 엔진의 원리</p>
                  <ul className="space-y-1.5 ml-1">
                    <li className="flex gap-2">
                      <span className="shrink-0">•</span>
                      <span>입력 신호를 중간에서 가로채 메모리 상에서 실시간으로 한글 자모를 조합합니다. 확정된 글자는 키 맵핑 정보를 일시적으로 변경하여 시스템에 전달하는 방식을 사용합니다.</span>
                    </li>
                  </ul>
                </div>

                {/* 3. 블루투스 도우미 (Smart Bluetooth) */}
                <div>
                  <p className="font-bold text-[15px] mb-2">3. 블루투스 도우미 (Smart Bluetooth)</p>
                  <ul className="space-y-1.5 ml-1">
                    <li className="flex gap-2">
                      <span className="shrink-0">•</span>
                      <span><strong>페어링 및 재연결 최적화:</strong> 저전력 블루투스(BLE) 키보드의 페어링을 통합 관리하고, 기기 재부팅이나 절전 모드 해제 시 자동으로 재연결되도록 돕습니다.</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="shrink-0">•</span>
                      <span><strong>전원 제어:</strong> 효율적인 배터리 관리를 위해 웹 UI에서 블루투스 전원을 직접 제어할 수 있는 기능을 제공합니다.</span>
                    </li>
                  </ul>
                </div>

                {/* 4. 기기 호환성 및 권장 설치 */}
                <div>
                  <p className="font-bold text-[15px] mb-2">4. 기기 호환성 및 권장 설치</p>
                  <ul className="space-y-1.5 ml-1">
                    <li className="flex gap-2">
                      <span className="shrink-0">•</span>
                      <span><strong>검증된 환경:</strong> 공식 Type Folio와 대부분의 최신 블루투스 LE 키보드에서 검증되었습니다. (Classic 전용 구형 키보드 미지원)</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="shrink-0">•</span>
                      <span><strong>권장 옵션:</strong> Type Folio만 사용하신다면 '한글 입력 엔진'만 설치해도 충분합니다. 외장 키보드를 함께 사용하신다면 '블루투스 도우미'를 포함하여 설치하는 것을 권장합니다.</span>
                    </li>
                  </ul>
                </div>

                {/* 5. 사전 준비 및 복구 */}
                <div>
                  <p className="font-bold text-[15px] mb-2">5. 사전 준비 및 복구</p>
                  <ul className="space-y-1.5 ml-1">
                    <li className="flex gap-2">
                      <span className="shrink-0">•</span>
                      <span><strong>기존 흔적 제거:</strong> 기존 <strong>ko-remark</strong> (by bncedgb-glitch) 프로젝트가 설치되어 있다면, <strong>해당 프로젝트의 원상복구 기능</strong>으로 초기화를 먼저 진행해야 합니다. (또는 기기의 팩토리 리셋 수행)</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="shrink-0">•</span>
                      <span><strong>재설치 및 복구:</strong> rekoit 사용 중에는 원상복구 없이도 언제든 다시 설치하여 설정을 갱신하거나 손상된 환경을 복구할 수 있습니다.</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="shrink-0">•</span>
                      <span><strong>완벽한 순정 상태 복구:</strong> '전체 원상복구' 기능을 통해 언제든지 설치 전의 순정 상태로 되돌릴 수 있습니다.</span>
                    </li>
                  </ul>
                </div>
              </div>
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
