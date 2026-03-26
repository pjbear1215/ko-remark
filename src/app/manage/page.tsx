"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/Button";
import BluetoothPowerControl from "@/components/BluetoothPowerControl";
import DiagnosisPanel from "@/components/DiagnosisPanel";
import KeyboardSwapControl from "@/components/KeyboardSwapControl";
import SectionDivider from "@/components/SectionDivider";
import { useSetup } from "@/lib/store";

export default function ManagePage() {
  const router = useRouter();
  const { state, setState } = useSetup();
  const returnPath = state.ip && state.password ? "/entry" : "/";

  const [mounted, setMounted] = useState(false);
  const [installedState, setInstalledState] = useState({
    hangul: state.installHangul,
    bt: state.installBtKeyboard,
  });
  const [fontUploading, setFontUploading] = useState(false);
  const [fontResult, setFontResult] = useState<string | null>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && (!state.ip || !state.password)) {
      router.replace("/");
    }
  }, [mounted, state.ip, state.password, router]);

  useEffect(() => {
    if (!mounted || !state.ip || !state.password) return;

    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch("/api/manage/availability", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ip: state.ip, password: state.password }),
        });
        const data = await res.json();
        if (cancelled || !res.ok) return;
        const nextInstalledState = {
          hangul: data.hangulInstalled === true,
          bt: data.btInstalled === true,
        };
        setInstalledState(nextInstalledState);
        setState({
          installHangul: nextInstalledState.hangul,
          installBtKeyboard: nextInstalledState.bt,
        });
      } catch {
        // fall back to in-memory state
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [mounted, state.ip, state.password]);

  if (!mounted || !state.ip || !state.password) {
    return null;
  }

  return (
    <div className="animate-fade-in-up">
      <div style={{ display: "flex", flexDirection: "column", gap: "40px" }}>
        <div className="flex items-start justify-between animate-fade-in-up">
          <div>
            <h1
              className="text-[36px] font-bold leading-tight"
              style={{ color: "var(--text-primary)" }}
            >
              기기 관리
            </h1>
            <p className="text-[15px]" style={{ color: "var(--text-muted)", marginTop: "8px" }}>
              다시 설정하지 않고, 현재 기기에서 필요한 항목만 바꿉니다.
            </p>
          </div>
          <Button variant="ghost" onClick={() => router.push(returnPath)}>
            처음으로
          </Button>
        </div>

        <div className="animate-fade-in-up stagger-1" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <SectionDivider label="원상복구" />
          <div
            className="card-interactive flex items-center justify-between"
            style={{ padding: "20px 24px" }}
          >
            <div>
              <p className="text-[16px] font-medium" style={{ color: "var(--text-primary)" }}>
                전체 원상복구
              </p>
              <p className="text-[14px]" style={{ color: "var(--text-muted)", marginTop: "4px" }}>
                설치된 항목을 감지한 뒤 원본 상태로 되돌립니다. 한글 폰트도 함께 제거됩니다.
              </p>
            </div>
            <Button variant="secondary" onClick={() => router.push("/uninstall")}>
              시작
            </Button>
          </div>
        </div>

        {(installedState.hangul || installedState.bt) && (
          <div className="animate-fade-in-up stagger-2" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <SectionDivider label="부분 제거" />
            <div className="grid gap-4 md:grid-cols-2">
              {installedState.hangul && (
                <div
                  className="card-interactive flex items-center justify-between"
                  style={{ padding: "20px 24px" }}
                >
                  <div>
                    <p className="text-[16px] font-medium" style={{ color: "var(--text-primary)" }}>
                      한글 입력 제거
                    </p>
                    <p className="text-[14px]" style={{ color: "var(--text-muted)", marginTop: "4px" }}>
                      한글 런타임, 폰트, libepaper 백업과 ReKoIt 한글 관련 파일만 제거합니다.
                    </p>
                  </div>
                  <Button variant="secondary" onClick={() => router.push("/uninstall?target=hangul")}>
                    시작
                  </Button>
                </div>
              )}

              {installedState.bt && (
                <div
                  className="card-interactive flex items-center justify-between"
                  style={{ padding: "20px 24px" }}
                >
                  <div>
                    <p className="text-[16px] font-medium" style={{ color: "var(--text-primary)" }}>
                      블루투스 제거
                    </p>
                    <p className="text-[14px]" style={{ color: "var(--text-muted)", marginTop: "4px" }}>
                      블루투스 설정, 페어링 데이터, ReKoIt 블루투스 관련 파일만 제거합니다.
                    </p>
                  </div>
                  <Button variant="secondary" onClick={() => router.push("/uninstall?target=bt")}>
                    시작
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {installedState.hangul && (
          <div className="animate-fade-in-up stagger-3" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <SectionDivider label="키보드" />
            <KeyboardSwapControl ip={state.ip} password={state.password} />
          </div>
        )}

        {installedState.bt && (
          <div className="animate-fade-in-up stagger-4" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <SectionDivider label="블루투스" />
            <div
              className="card-interactive flex items-center justify-between"
              style={{ padding: "20px 24px" }}
            >
              <div>
                <p className="text-[16px] font-medium" style={{ color: "var(--text-primary)" }}>
                  키보드 재설정
                </p>
                <p className="text-[14px]" style={{ color: "var(--text-muted)", marginTop: "4px" }}>
                  다시 스캔하고 다른 블루투스 키보드를 페어링하거나 기존 연결을 바꿉니다.
                </p>
              </div>
              <Button variant="secondary" onClick={() => router.push("/bluetooth?mode=manage")}>
                열기
              </Button>
            </div>
            <BluetoothPowerControl ip={state.ip} password={state.password} />
          </div>
        )}

        {installedState.hangul && (
          <div className="animate-fade-in-up stagger-5" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <SectionDivider label="폰트 교체" />
            <input
              ref={fontInputRef}
              type="file"
              accept=".otf,.ttf"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setFontUploading(true);
                setFontResult(null);
                const formData = new FormData();
                formData.append("font", file);
                formData.append("ip", state.ip);
                formData.append("password", state.password);
                try {
                  const res = await fetch("/api/font/upload", { method: "POST", body: formData });
                  const data = await res.json();
                  setFontResult(data.success ? data.message : `실패: ${data.error}`);
                } catch {
                  setFontResult("서버 오류");
                } finally {
                  setFontUploading(false);
                  if (fontInputRef.current) fontInputRef.current.value = "";
                }
              }}
            />
            <div
              className="card-interactive flex items-center justify-between"
              style={{ padding: "20px 24px" }}
            >
              <span className="text-[15px] font-medium" style={{ color: "var(--text-muted)" }}>
                OTF/TTF 파일 업로드
              </span>
              <Button variant="secondary" size="sm" onClick={() => fontInputRef.current?.click()} loading={fontUploading}>
                {fontUploading ? "업로드 중..." : "선택"}
              </Button>
            </div>
            {fontResult && (
              <p className="text-[14px] animate-fade-in" style={{ color: fontResult.includes("실패") ? "var(--error)" : "var(--success)", paddingLeft: "4px" }}>
                {fontResult}
              </p>
            )}
          </div>
        )}

        <DiagnosisPanel
          ip={state.ip}
          password={state.password}
          title="진단"
          subtitle="문제 원인 확인"
          className="animate-fade-in-up stagger-6"
        />
      </div>
    </div>
  );
}
