"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
import BluetoothPowerControl from "@/components/BluetoothPowerControl";
import DiagnosisPanel from "@/components/DiagnosisPanel";
import KeyboardSwapControl from "@/components/KeyboardSwapControl";
import SectionDivider from "@/components/SectionDivider";
import StatusCheck from "@/components/StatusCheck";
import { useSetup } from "@/lib/store";
import { useGuard } from "@/lib/useGuard";

interface VerifyResult {
  name: string;
  pass: boolean;
  detail: string;
}

function getInstallSummary(installHangul: boolean, installBtKeyboard: boolean): string {
  if (installHangul && installBtKeyboard) {
    return "한글 입력 엔진과 블루투스 도우미 설치를 확인합니다.";
  }
  if (installHangul) {
    return "한글 입력 엔진 설정을 확인합니다.";
  }
  return "블루투스 도우미 설치를 확인합니다.";
}

export default function CompletePage() {
  const allowed = useGuard();
  const router = useRouter();
  const { state, setState } = useSetup();
  const [results, setResults] = useState<VerifyResult[]>([]);
  const [verifying, setVerifying] = useState(true);
  const [btRemoving, setBtRemoving] = useState(false);
  const [btRemoveResult, setBtRemoveResult] = useState<string | null>(null);
  const [fontUploading, setFontUploading] = useState(false);
  const [fontResult, setFontResult] = useState<string | null>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);

  const placeholderChecks = [
    ...(state.installHangul ? ["한글 폰트", "한글 입력 데몬"] : []),
    ...(state.installBtKeyboard ? ["블루투스"] : []),
  ];

  useEffect(() => {
    if (!allowed) return;
    const verify = async () => {
      try {
        const res = await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ip: state.ip,
            password: state.password,
            hangul: state.installHangul,
            bt: state.installBtKeyboard,
          }),
        });
        const data = await res.json();
        setResults(data.results);
      } catch {
        setResults([{
          name: "검증 실패",
          pass: false,
          detail: "서버에 연결할 수 없습니다.",
        }]);
      } finally {
        setVerifying(false);
      }
    };
    verify();
  }, [allowed, state.installBtKeyboard, state.installHangul, state.ip, state.password]);

  const handleBtRemove = useCallback(
    async (address: string) => {
      setBtRemoving(true);
      setBtRemoveResult(null);
      try {
        const res = await fetch("/api/bluetooth/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ip: state.ip, password: state.password, address }),
        });
        const data = await res.json();
        if (data.success) {
          setBtRemoveResult("연결 해제됨");
          setState({ btDeviceAddress: undefined, btDeviceName: undefined });
        } else {
          setBtRemoveResult(`실패: ${data.error ?? "알 수 없는 오류"}`);
        }
      } catch {
        setBtRemoveResult("서버 오류");
      } finally {
        setBtRemoving(false);
      }
    },
    [state.ip, state.password, setState],
  );

  const handleFontUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setFontUploading(true);
      setFontResult(null);

      const formData = new FormData();
      formData.append("font", file);
      formData.append("ip", state.ip);
      formData.append("password", state.password);

      try {
        const res = await fetch("/api/font/upload", {
          method: "POST",
          body: formData,
        });
        const data = await res.json();
        if (data.success) {
          setFontResult(data.message);
        } else {
          setFontResult(`실패: ${data.error}`);
        }
      } catch {
        setFontResult("서버 오류");
      } finally {
        setFontUploading(false);
        if (fontInputRef.current) fontInputRef.current.value = "";
      }
    },
    [state.ip, state.password],
  );

  const allPassed = results.length > 0 && results.every((r) => r.pass);
  const hasFail = results.length > 0 && results.some((r) => !r.pass);
  const failedCheckNames = results.filter((r) => !r.pass).map((r) => r.name);
  const hasHangulFail = failedCheckNames.some((name) => name === "한글 폰트" || name === "한글 입력 데몬");
  const hasBtFail = failedCheckNames.includes("블루투스");
  const returnPath = state.ip && state.password ? "/entry" : "/";

  if (!allowed) return null;

  return (
    <div className="animate-fade-in-up">
      <StepIndicator currentStep={6} />

      <div className="space-y-6">
        <div>
          <h1
            className="text-[36px] font-bold leading-tight"
            style={{ color: "#000000" }}
          >
            {verifying ? "확인 중..." : allPassed ? "설치 완료" : "설치 결과"}
          </h1>
          <p
            className="mt-3 text-[17px] font-medium"
            style={{ color: "#666666" }}
          >
            {getInstallSummary(state.installHangul, state.installBtKeyboard)}
          </p>
        </div>

        <div className="stagger-1">
          <div className="operator-card operator-card-strong" style={{ padding: "20px 24px", border: "1.5px solid #000000" }}>
            <div className="space-y-8">
              {/* 검증 상태 */}
              <div
                className="border border-black/10 overflow-hidden bg-black/[0.02]"
              >
                {verifying ? (
                  placeholderChecks.map((name) => (
                    <StatusCheck key={name} label={name} status="checking" />
                  ))
                ) : (
                  results.map((result) => (
                    <StatusCheck
                      key={result.name}
                      label={result.name}
                      status={result.pass ? "pass" : "fail"}
                      detail={result.detail}
                    />
                  ))
                )}
              </div>

              {/* 결과 메시지 */}
              {!verifying && allPassed && (
                <div
                  className="text-center py-8 bg-[#e6f4ea] border border-[#1e8e3e] animate-scale-in"
                >
                  <p className="text-[20px] font-bold" style={{ color: "#1e8e3e" }}>
                    설치가 완료되었습니다
                  </p>
                  <p className="text-[15px] mt-2 font-medium" style={{ color: "rgba(0,0,0,0.6)" }}>
                    {state.installHangul
                      ? "지구본 아이콘을 눌러 Korean을 선택하세요."
                      : "블루투스 키보드 페어링을 진행하면 바로 사용할 수 있습니다."}
                  </p>
                </div>
              )}

              {/* 실패 시 안내 */}
              {!verifying && hasFail && (
                <div
                  className="p-6 bg-[#fce8e6] border border-[#d93025] animate-fade-in"
                >
                  <p className="font-bold text-[17px]" style={{ color: "#d93025" }}>
                    일부 항목에서 문제가 발견되었습니다
                  </p>
                  <ul className="mt-3 space-y-2 text-[14px] font-medium" style={{ color: "rgba(0,0,0,0.7)" }}>
                    {hasHangulFail && (
                      <li>한글 입력 엔진 문제가 있으면 기기를 재시작한 뒤 다시 확인하세요.</li>
                    )}
                    {hasHangulFail && (
                      <li>데몬 문제 시 <code className="text-[12px] font-mono px-1.5 py-0.5 bg-black text-white">systemctl restart hangul-daemon</code></li>
                    )}
                    {hasBtFail && (
                      <li>블루투스 도우미 설치 문제가 있으면 기기를 재시작한 뒤 다시 확인하세요.</li>
                    )}
                    <li>&quot;처음으로&quot;를 눌러 설치를 다시 진행해 보세요.</li>
                  </ul>
                </div>
              )}

              {/* 빠른 관리 도구 */}
              {!verifying && (
                <div className="space-y-8 border-t border-black/10 pt-8">
                  {state.installHangul && (
                    <div className="space-y-4">
                      <SectionDivider label="키보드 레이아웃" />
                      <KeyboardSwapControl ip={state.ip} password={state.password} />
                    </div>
                  )}

                  {state.installBtKeyboard && (
                    <div className="space-y-4">
                      <SectionDivider label="블루투스 제어" />
                      <div className="flex items-center justify-between p-4 bg-black/[0.03] border border-black/5">
                        <div className="min-w-0">
                          <p className="text-[16px] font-bold text-black">블루투스 키보드 재설정</p>
                          <p className="text-[13px] font-medium opacity-50 mt-0.5">다른 키보드 연결이 필요할 때 사용하세요.</p>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => router.push("/bluetooth?mode=manage")}
                          className="font-bold"
                        >
                          설정 열기
                        </Button>
                      </div>
                      <BluetoothPowerControl ip={state.ip} password={state.password} />
                    </div>
                  )}

                  {state.installHangul && (
                    <div className="space-y-4">
                      <SectionDivider label="폰트 관리" />
                      <div className="flex items-center justify-between p-4 bg-black/[0.03] border border-black/5">
                        <span className="text-[15px] font-bold">사용자 폰트 업로드</span>
                        <input ref={fontInputRef} type="file" accept=".otf,.ttf" onChange={handleFontUpload} className="hidden" />
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => fontInputRef.current?.click()}
                          loading={fontUploading}
                          className="font-bold"
                        >
                          파일 선택
                        </Button>
                      </div>
                      {fontResult && (
                        <p className="text-[13px] font-bold px-1" style={{ color: fontResult.includes("실패") ? "#d93025" : "#1e8e3e" }}>
                          {fontResult}
                        </p>
                      )}
                    </div>
                  )}

                  <DiagnosisPanel
                    ip={state.ip}
                    password={state.password}
                    title="시스템 진단"
                    subtitle="입력 엔진 동작 상태 점검"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 네비게이션 */}
        <div className="flex justify-between pt-4 stagger-2">
          <Button variant="ghost" onClick={() => router.push(returnPath)} disabled={verifying} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>}>
            처음으로
          </Button>
          <Button onClick={() => router.push("/manage")} disabled={verifying} size="lg" className="px-12 font-bold">
            기기 관리로
          </Button>
        </div>
      </div>
    </div>
  );
}
