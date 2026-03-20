"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
import Checkbox from "@/components/Checkbox";
import { useSetup } from "@/lib/store";
import { useGuard } from "@/lib/useGuard";

type EntryMode = "install" | "manage";

export default function EntryPage() {
  const allowed = useGuard();
  const router = useRouter();
  const { state, setState } = useSetup();
  const [entryMode, setEntryMode] = useState<EntryMode>("install");
  const [entryModeTouched, setEntryModeTouched] = useState(false);
  const [manageAvailable, setManageAvailable] = useState<boolean | null>(null);
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
        if (!installed) {
          setEntryMode("install");
        } else if (!entryModeTouched) {
          setEntryMode("manage");
        }
        if (!res.ok && data.error) {
          setManageCheckError("설정 변경 가능 여부를 확인하지 못했습니다.");
        }
      } catch {
        if (cancelled) return;
        setManageAvailable(false);
        setManageCheckError("설정 변경 가능 여부를 확인하지 못했습니다.");
        setEntryMode("install");
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
  }, [allowed, state.ip, state.password, entryModeTouched]);

  if (!allowed) return null;

  const canManage = manageAvailable === true;
  const isInstallMode = entryMode === "install";
  const installTitle = canManage ? "재설치" : "처음 설치";
  const installDescription = canManage
    ? "현재 설치 상태를 다시 적용하거나 복구가 필요할 때 다시 설치를 진행합니다."
    : "Type Folio와 블루투스 키보드용 한글 입력을 새로 설치합니다.";

  const handleNext = () => {
    setState({ eulaAgreed: isInstallMode ? eulaChecked : state.eulaAgreed });
    router.push(isInstallMode ? "/install" : "/manage");
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
          <div className="grid gap-3 md:grid-cols-2">
            {([
              {
                id: "install" as const,
                title: installTitle,
                description: installDescription,
              },
              {
                id: "manage" as const,
                title: "기기 관리",
                description: "다시 설치하지 않고 현재 기기의 옵션과 연결을 바꿉니다.",
              },
            ]).map((mode) => {
              const selected = entryMode === mode.id;
              const disabled = mode.id === "manage" && !canManage;
              return (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => {
                    if (!disabled) {
                      setEntryModeTouched(true);
                      setEntryMode(mode.id);
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
                    {mode.title}
                  </p>
                  <p className="text-[14px] mt-2" style={{ color: "var(--text-muted)" }}>
                    {disabled
                      ? manageChecking
                        ? "기기 관리 가능 여부를 확인하고 있습니다."
                        : "hangul-daemon이 설치된 기기에서만 사용할 수 있습니다."
                      : mode.description}
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

        {isInstallMode && (
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
            disabled={manageChecking || (!isInstallMode && !canManage) || (isInstallMode && !eulaChecked)}
            size="lg"
          >
            {isInstallMode ? `${installTitle} 계속하기` : "기기 관리로"}
          </Button>
        </div>
      </div>
    </div>
  );
}
