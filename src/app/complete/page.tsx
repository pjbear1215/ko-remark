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
    return "한글 입력과 블루투스 설치를 확인합니다.";
  }
  if (installHangul) {
    return "한글 입력 설정을 확인합니다.";
  }
  return "블루투스 설치를 확인합니다.";
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

      <div className="space-y-10">
        <div>
          <h1
            className="text-[36px] font-bold leading-tight"
            style={{ color: "var(--text-primary)" }}
          >
            {verifying ? "확인 중..." : allPassed ? "설치 완료" : "설치 결과"}
          </h1>
          <p
            className="mt-3 text-[17px]"
            style={{ color: "var(--text-muted)" }}
          >
            {getInstallSummary(state.installHangul, state.installBtKeyboard)}
          </p>
        </div>

        {/* 검증 */}
        <div
          className="rounded-xl overflow-hidden"
          style={{ backgroundColor: "var(--bg-card)", border: "1px solid var(--border-light)" }}
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

        {/* 성공 */}
        {!verifying && allPassed && (
          <div
            className="text-center py-8 rounded-xl animate-scale-in"
            style={{ backgroundColor: "var(--success-light)" }}
          >
            <p className="text-[20px] font-semibold" style={{ color: "var(--success)" }}>
              설치가 완료되었습니다
            </p>
            <p className="text-[15px] mt-2" style={{ color: "var(--text-muted)" }}>
              {state.installHangul
                ? "지구본 아이콘을 눌러 Korean을 선택하세요."
                : "블루투스 키보드 페어링을 진행하면 바로 사용할 수 있습니다."}
            </p>
          </div>
        )}

        {/* 부분 실패 */}
        {!verifying && hasFail && (
          <div
            className="p-6 rounded-xl animate-fade-in"
            style={{ backgroundColor: "var(--warning-light)" }}
          >
            <p className="font-medium text-[17px]" style={{ color: "var(--text-primary)" }}>
              일부 항목에서 문제가 발견되었습니다
            </p>
            <ul className="mt-3 space-y-1.5 text-[15px]" style={{ color: "var(--text-muted)" }}>
              {hasHangulFail && (
                <li>한글 입력 문제가 있으면 기기를 재시작한 뒤 다시 확인하세요.</li>
              )}
              {hasHangulFail && (
                <li>데몬 문제 시 <code className="text-[13px] font-mono px-2 py-1 rounded-md" style={{ backgroundColor: "var(--terminal-bg)", color: "var(--terminal-text)" }}>systemctl restart hangul-daemon</code></li>
              )}
              {hasBtFail && (
                <li>블루투스 설치 문제가 있으면 기기를 재시작한 뒤 다시 확인하세요.</li>
              )}
              {hasBtFail && (
                <li>스캔을 건너뛰었다면, 설치만 완료된 상태일 수 있으니 이후 페어링 화면에서 다시 연결하면 됩니다.</li>
              )}
              <li>&quot;처음으로&quot;를 눌러 {state.installHangul ? "설치" : "블루투스 설치"}를 다시 적용하세요.</li>
            </ul>
          </div>
        )}


        {/* 관리 섹션 */}
        {!verifying && (
          <div className="space-y-8 pt-4">
            {state.installHangul && (
              <div className="space-y-4 animate-fade-in-up stagger-1">
                <SectionDivider label="키보드" />
                <KeyboardSwapControl ip={state.ip} password={state.password} />
              </div>
            )}

            {/* 블루투스 관리 */}
            {state.installBtKeyboard && (
              <div className="space-y-4 animate-fade-in-up stagger-2">
                <SectionDivider label="블루투스" />

                <div className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-[16px] font-medium" style={{ color: "var(--text-primary)" }}>
                      블루투스 키보드 재설정
                    </p>
                    <p className="text-[14px] mt-1" style={{ color: "var(--text-muted)" }}>
                      스캔을 건너뛰었거나 다른 키보드를 연결하려면 여기서 다시 페어링하세요.
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => router.push("/bluetooth?mode=manage")}
                  >
                    열기
                  </Button>
                </div>

                {state.btDeviceName && (
                  <div className="flex items-center justify-between py-2">
                    <span className="text-[16px]" style={{ color: "var(--text-secondary)" }}>
                      {state.btDeviceName}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => state.btDeviceAddress && handleBtRemove(state.btDeviceAddress)}
                      loading={btRemoving}
                    >
                      해제
                    </Button>
                  </div>
                )}
                {btRemoveResult && (
                  <p className="text-[14px]" style={{ color: btRemoveResult.includes("실패") ? "var(--error)" : "var(--success)" }}>
                    {btRemoveResult}
                  </p>
                )}

                <BluetoothPowerControl ip={state.ip} password={state.password} />
              </div>
            )}

            {/* 폰트 교체 */}
            {state.installHangul && (
              <div className="space-y-4 animate-fade-in-up stagger-3">
                <SectionDivider label="폰트 교체" />
                <div className="flex items-center justify-between py-2">
                  <span className="text-[16px]" style={{ color: "var(--text-muted)" }}>
                    OTF/TTF 파일 업로드
                  </span>
                  <input
                    ref={fontInputRef}
                    type="file"
                    accept=".otf,.ttf"
                    onChange={handleFontUpload}
                    className="hidden"
                    id="font-upload"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => fontInputRef.current?.click()}
                    loading={fontUploading}
                  >
                    {fontUploading ? "업로드 중..." : "선택"}
                  </Button>
                </div>
                {fontResult && (
                  <p className="text-[14px]" style={{ color: fontResult.includes("실패") ? "var(--error)" : "var(--success)" }}>
                    {fontResult}
                  </p>
                )}
              </div>
            )}

            {/* 진단 */}
            <DiagnosisPanel
              ip={state.ip}
              password={state.password}
              title="진단"
              subtitle="키보드 문제 진단"
              className="animate-fade-in-up stagger-4"
            />

          </div>
        )}

        {/* 네비게이션 */}
        <div className="flex justify-between pt-4">
          <Button variant="secondary" onClick={() => router.push(returnPath)} disabled={verifying}>
            처음으로
          </Button>
          <Button onClick={() => router.push("/manage")} disabled={verifying} size="lg">
            기기 관리
          </Button>
        </div>
      </div>
    </div>
  );
}
