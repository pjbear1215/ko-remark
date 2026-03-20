"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
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

export default function CompletePage() {
  const allowed = useGuard();
  const router = useRouter();
  const { state, setState } = useSetup();
  const [results, setResults] = useState<VerifyResult[]>([]);
  const [verifying, setVerifying] = useState(true);
  const [btPowering, setBtPowering] = useState(false);
  const [btPowerResult, setBtPowerResult] = useState<string | null>(null);
  const [btRemoving, setBtRemoving] = useState(false);
  const [btRemoveResult, setBtRemoveResult] = useState<string | null>(null);
  const [fontUploading, setFontUploading] = useState(false);
  const [fontResult, setFontResult] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagResult, setDiagResult] = useState<Record<string, string> | null>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);

  const placeholderChecks = [
    "한글 폰트",
    ...(state.installBtKeyboard ? ["BT 데몬", "블루투스"] : []),
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
  }, [allowed, state.installBtKeyboard, state.ip, state.password]);

  const handleBtPower = useCallback(
    async (action: "on" | "off") => {
      setBtPowering(true);
      setBtPowerResult(null);
      try {
        const res = await fetch("/api/bluetooth/power", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ip: state.ip, password: state.password, action }),
        });
        const data = await res.json();
        if (data.success) {
          setBtPowerResult(action === "on" ? "활성화됨" : "비활성화됨");
        } else {
          setBtPowerResult(`실패: ${data.error ?? "알 수 없는 오류"}`);
        }
      } catch {
        setBtPowerResult("서버 오류");
      } finally {
        setBtPowering(false);
      }
    },
    [state.ip, state.password],
  );

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
            한글 입력 설정을 확인합니다.
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
              지구본 아이콘을 눌러 Korean을 선택하세요.
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
              <li>폰트 문제 시 기기 재시작</li>
              <li>데몬 문제 시 <code className="text-[13px] font-mono px-2 py-1 rounded-md" style={{ backgroundColor: "var(--terminal-bg)", color: "var(--terminal-text)" }}>systemctl restart hangul-daemon</code></li>
              <li>&quot;처음으로&quot;를 눌러 재설치</li>
            </ul>
          </div>
        )}


        {/* 관리 섹션 */}
        {!verifying && (
          <div className="space-y-8 pt-4">
            <div className="space-y-4 animate-fade-in-up stagger-1">
              <SectionDivider label="키보드" />
              <KeyboardSwapControl ip={state.ip} password={state.password} />
            </div>

            {/* 블루투스 관리 */}
            <div className="space-y-4 animate-fade-in-up stagger-2">
              <SectionDivider label="블루투스" />

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

              <div className="flex items-center justify-between py-2">
                <span className="text-[16px]" style={{ color: "var(--text-secondary)" }}>
                  전원
                </span>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => handleBtPower("on")} loading={btPowering}>
                    켜기
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleBtPower("off")} loading={btPowering}>
                    끄기
                  </Button>
                </div>
              </div>
              {btPowerResult && (
                <p className="text-[14px]" style={{ color: btPowerResult.includes("실패") ? "var(--error)" : "var(--success)" }}>
                  {btPowerResult}
                </p>
              )}
            </div>

            {/* 폰트 교체 */}
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

            {/* 진단 */}
            <div className="space-y-4 animate-fade-in-up stagger-4">
              <SectionDivider label="진단" />
              <div className="flex items-center justify-between py-2">
                <span className="text-[16px]" style={{ color: "var(--text-muted)" }}>
                  키보드 문제 진단
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    setDiagnosing(true);
                    setDiagResult(null);
                    try {
                      const res = await fetch("/api/diagnose", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ ip: state.ip, password: state.password }),
                      });
                      const data = await res.json();
                      setDiagResult(data.results);
                    } catch {
                      setDiagResult({ error: "서버 오류" });
                    } finally {
                      setDiagnosing(false);
                    }
                  }}
                  loading={diagnosing}
                >
                  실행
                </Button>
              </div>
              {diagResult && (
                <div
                  className="p-4 rounded-xl overflow-auto text-[12px] font-mono leading-[20px]"
                  style={{
                    background: "linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)",
                    color: "var(--terminal-text)",
                    maxHeight: "400px",
                  }}
                >
                  {Object.entries(diagResult).map(([key, value]) => (
                    <div key={key} className="mb-3">
                      <div style={{ color: "#818cf8" }}>--- {key} ---</div>
                      <pre className="whitespace-pre-wrap break-all">{value}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        )}

        {/* 네비게이션 */}
        <div className="flex justify-between pt-4">
          <Button variant="secondary" onClick={() => router.push("/")} disabled={verifying}>
            처음으로
          </Button>
          <Button onClick={() => router.push("/manage")} disabled={verifying} size="lg">
            설정 변경
          </Button>
        </div>
      </div>
    </div>
  );
}
