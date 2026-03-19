"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
import Checkbox from "@/components/Checkbox";
import { useSetup } from "@/lib/store";

export default function WelcomePage() {
  const router = useRouter();
  const { state, setState } = useSetup();
  const [ip, setIp] = useState("10.11.99.1");
  const [password, setPassword] = useState("");
  const [mounted, setMounted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<"connected" | "disconnected" | null>(null);
  const [eulaChecked, setEulaChecked] = useState(state.eulaAgreed);
  const [showUsbWarning, setShowUsbWarning] = useState(false);

  useEffect(() => {
    if (state.ip) setIp(state.ip);
    if (state.password) setPassword(state.password);
    setMounted(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePing = async () => {
    setPinging(true);
    setPingResult(null);
    try {
      const res = await fetch(`/api/ping?ip=${encodeURIComponent(ip)}`);
      const data = await res.json();
      setPingResult(data.reachable ? "connected" : "disconnected");
      if (data.reachable) {
        setState({ ip, password, connected: true });
      }
    } catch {
      setPingResult("disconnected");
    } finally {
      setPinging(false);
    }
  };

  const isReachable = pingResult === "connected";

  const handleNext = () => {
    setState({ ip, password, eulaAgreed: eulaChecked });
    router.push("/prerequisites");
  };

  return (
    <div className="animate-fade-in-up">
      <StepIndicator currentStep={0} />

      <div className="space-y-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1
              className="text-[36px] font-bold leading-tight"
              style={{ color: "var(--text-primary)" }}
            >
              ko-remark
            </h1>
            <p
              className="mt-3 text-[17px]"
              style={{ color: "var(--text-muted)" }}
            >
              USB 연결을 확인한 뒤, Type Folio와 블루투스 키보드용 한글 입력 설치를 진행합니다.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (isReachable && password) {
                setShowUsbWarning(false);
                setState({ ip, password });
                router.push("/manage");
              } else {
                setShowUsbWarning(true);
              }
            }}
          >
            기기 관리
          </Button>
        </div>

        <div className="space-y-5 stagger-1">
          <span
            className="text-[12px] font-semibold uppercase tracking-[0.12em]"
            style={{
              color: "var(--text-muted)",
              backgroundColor: "var(--bg-secondary)",
              padding: "5px 14px",
              borderRadius: "var(--radius-full)",
              border: "1px solid var(--border-light)",
            }}
          >
            1. 기기 연결
          </span>

          <div className="operator-card operator-card-strong" style={{ padding: "24px" }}>
            <div className="space-y-5">
              <div>
                <label
                  className="block text-[13px] font-medium mb-2"
                  style={{ color: "var(--text-muted)" }}
                >
                  IP 주소
                </label>
                <input
                  type="text"
                  value={ip}
                  onChange={(e) => {
                    setIp(e.target.value);
                    setPingResult(null);
                  }}
                  className="w-full text-[17px] rounded-xl input-enhanced"
                  style={{
                    backgroundColor: "var(--bg-card)",
                    border: "1.5px solid var(--border-light)",
                    color: "var(--text-primary)",
                    padding: "14px 20px",
                  }}
                  placeholder="10.11.99.1"
                />
              </div>

              <div>
                <label
                  className="block text-[13px] font-medium mb-2"
                  style={{ color: "var(--text-muted)" }}
                >
                  SSH 비밀번호
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pr-12 text-[17px] rounded-xl input-enhanced"
                    style={{
                      backgroundColor: "var(--bg-card)",
                      border: "1.5px solid var(--border-light)",
                      color: "var(--text-primary)",
                      padding: "14px 20px",
                    }}
                    placeholder="비밀번호"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 p-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      {showPassword ? (
                        <>
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </>
                      ) : (
                        <>
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </>
                      )}
                    </svg>
                  </button>
                </div>
                <p
                  className="mt-2 text-[13px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  설정 &gt; 일반 &gt; 도움말 &gt; 저작권 및 라이선스에서 확인할 수 있습니다.
                </p>
              </div>

              <div
                className="rounded-xl"
                style={{
                  backgroundColor: "var(--bg-secondary)",
                  padding: "18px 20px",
                  border: "1px solid var(--border-light)",
                }}
              >
                <p className="text-[14px] font-medium" style={{ color: "var(--text-primary)" }}>
                  연결 전에 확인하세요
                </p>
                <ul className="mt-2 space-y-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  <li>- USB 케이블이 연결되어 있어야 합니다.</li>
                  <li>- 기기에서 개발자 모드와 SSH가 켜져 있어야 합니다.</li>
                  <li>- 연결 확인이 끝나면 다음 단계에서 설치를 바로 진행할 수 있습니다.</li>
                </ul>
              </div>

              <Button
                onClick={handlePing}
                loading={pinging}
                disabled={!mounted || !ip || !password}
                variant="secondary"
                className="w-full"
                size="lg"
              >
                USB 연결 확인
              </Button>

              {pingResult && (
                <div
                  className="rounded-xl text-[16px] animate-fade-in"
                  style={{
                    backgroundColor: isReachable ? "var(--success-light)" : "var(--error-light)",
                    color: isReachable ? "var(--success)" : "var(--error)",
                    padding: "20px 24px",
                  }}
                >
                  {isReachable
                    ? "USB 연결 확인됨. 다음 단계로 진행할 수 있습니다."
                    : "연결할 수 없습니다. USB 케이블과 SSH 비밀번호를 다시 확인하세요."}
                </div>
              )}

              {showUsbWarning && !isReachable && (
                <div
                  className="rounded-xl text-[16px] animate-fade-in"
                  style={{
                    backgroundColor: "var(--warning-light)",
                    color: "var(--warning)",
                    padding: "20px 24px",
                  }}
                >
                  기기 관리를 사용하려면 먼저 USB 연결 확인을 완료해야 합니다.
                </div>
              )}
            </div>
          </div>
        </div>

        {isReachable && (
          <div className="space-y-4 stagger-2">
            <div style={{ height: "1px", backgroundColor: "var(--border-light)" }} />
            <div
              className="p-6 rounded-xl text-[13px] leading-[22px] overflow-auto"
              style={{
                backgroundColor: "var(--bg-secondary)",
                maxHeight: "240px",
                color: "var(--text-muted)",
              }}
            >
              <p className="font-semibold text-[14px] mb-3" style={{ color: "var(--text-primary)" }}>
                시작 전에 꼭 읽어주세요
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

        <div className="flex justify-end pt-4 stagger-3">
          <Button
            onClick={handleNext}
            disabled={!mounted || !isReachable || !password || !eulaChecked}
            size="lg"
          >
            다음 단계로
          </Button>
        </div>
      </div>
    </div>
  );
}
