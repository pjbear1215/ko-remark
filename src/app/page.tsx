"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
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
    setState({ ip, password, connected: true });
    router.push("/prerequisites");
  };

  return (
    <div className="animate-fade-in-up">
      <StepIndicator currentStep={0} />

      <div className="space-y-10">
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
            USB 연결과 SSH 정보를 확인한 뒤 다음 단계로 진행하세요.
          </p>
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
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setPingResult(null);
                    }}
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
                  <li>- 연결 확인이 끝나면 사전 준비와 기기 확인을 진행합니다.</li>
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
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-4 stagger-2">
          <Button
            onClick={handleNext}
            disabled={!mounted || !isReachable || !password}
            size="lg"
          >
            다음
          </Button>
        </div>
      </div>
    </div>
  );
}
