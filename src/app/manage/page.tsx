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
    font: false,
  });
  const [fontActionLoading, setFontActionLoading] = useState(false);
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
          font: data.fontInstalled === true,
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

  const handleRemoveFont = async () => {
    if (!confirm("정말 한글 폰트를 제거하시겠습니까? 한글 입력 엔진이 설치된 상태라면 한글이 보이지 않게 됩니다.")) return;
    
    setFontActionLoading(true);
    setFontResult(null);
    try {
      const res = await fetch("/api/manage/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: state.ip, password: state.password, target: "font" }),
      });
      const data = await res.json();
      if (data.success) {
        setFontResult("폰트 제거 성공");
        setInstalledState(prev => ({ ...prev, font: false }));
      } else {
        setFontResult(`실패: ${data.error}`);
      }
    } catch {
      setFontResult("서버 오류");
    } finally {
      setFontActionLoading(false);
    }
  };

  if (!mounted || !state.ip || !state.password) {
    return null;
  }

  return (
    <div className="animate-fade-in-up">
      <div className="space-y-6">
        <div>
          <h1
            className="text-[32px] font-bold tracking-tight"
            style={{ color: "#000000" }}
          >
            기기 관리
          </h1>
          <p className="text-[15px] mt-2 font-medium" style={{ color: "#666666" }}>
            다시 설정하지 않고, 현재 기기에서 필요한 항목만 바꿉니다.
          </p>
        </div>

        <div className="stagger-1">
          <div className="space-y-10">
            {/* 원상복구 섹션 */}
              <div className="space-y-4">
                <SectionDivider label="복구 및 제거" />
                <div className="space-y-4">
                  {(installedState.hangul || installedState.bt) && (
                    <div
                      className="flex items-center justify-between p-4 bg-black/[0.03] border border-black/5"
                    >
                      <div>
                        <p className="text-[16px] font-bold text-black">전체 원상복구</p>
                        <p className="text-[13px] font-medium opacity-50 mt-0.5">모든 설치 항목을 제거하고 기기를 순정 상태로 되돌립니다. (한글 폰트는 유지됨)</p>
                      </div>
                      <Button variant="primary" size="sm" onClick={() => router.push("/uninstall")} className="font-bold">
                        시작
                      </Button>
                    </div>
                  )}

                  <div className="grid gap-4 md:grid-cols-2">
                    {installedState.hangul && (
                      <div
                        className="flex items-center justify-between p-4 bg-black/[0.03] border border-black/5"
                      >
                        <div>
                          <p className="text-[16px] font-bold text-black">한글 입력 엔진 제거</p>
                          <p className="text-[13px] font-medium opacity-50 mt-0.5">한글 관련 파일만 정리합니다. (폰트 유지)</p>
                        </div>
                        <Button variant="primary" size="sm" onClick={() => router.push("/uninstall?target=hangul")} className="font-bold">
                          시작
                        </Button>
                      </div>
                    )}

                    {installedState.bt && (
                      <div
                        className="flex items-center justify-between p-4 bg-black/[0.03] border border-black/5"
                      >
                        <div>
                          <p className="text-[16px] font-bold text-black">블루투스 도우미 제거</p>
                          <p className="text-[13px] font-medium opacity-50 mt-0.5">블루투스 설정만 정리합니다.</p>
                        </div>
                        <Button variant="primary" size="sm" onClick={() => router.push("/uninstall?target=bt")} className="font-bold">
                          시작
                        </Button>
                      </div>
                    )}

                    {installedState.font && (
                      <div
                        className="flex items-center justify-between p-4 bg-black/[0.03] border border-black/5"
                      >
                        <div>
                          <p className="text-[16px] font-bold text-black">한글 폰트만 제거</p>
                          <p className="text-[13px] font-medium opacity-50 mt-0.5">설치된 폰트 파일만 삭제합니다.</p>
                        </div>
                        <Button 
                          variant="primary" 
                          size="sm" 
                          onClick={handleRemoveFont} 
                          loading={fontActionLoading} 
                          className="font-bold"
                        >
                          삭제
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 키보드 설정 */}
              {installedState.hangul && (
                <div className="space-y-4">
                  <SectionDivider label="키보드 레이아웃" />
                  <KeyboardSwapControl ip={state.ip} password={state.password} />
                </div>
              )}

              {/* 폰트 설정 */}
              <div className="space-y-4">
                <SectionDivider label="폰트 관리" />
                <div className="grid gap-4">
                  <div
                    className="flex items-center justify-between p-4 bg-black/[0.03] border border-black/5"
                  >
                    <div>
                      <p className="text-[16px] font-bold text-black">사용자 폰트 업로드</p>
                      <p className="text-[13px] font-medium opacity-50 mt-0.5">기본 Noto Sans 외의 다른 폰트를 사용하고 싶을 때 업로드합니다.</p>
                    </div>
                    <input
                      ref={fontInputRef}
                      type="file"
                      accept=".otf,.ttf"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setFontActionLoading(true);
                        setFontResult(null);
                        const formData = new FormData();
                        formData.append("font", file);
                        formData.append("ip", state.ip);
                        formData.append("password", state.password);
                        try {
                          const res = await fetch("/api/font/upload", { method: "POST", body: formData });
                          const data = await res.json();
                          if (data.success) {
                            setFontResult("폰트 업로드 성공");
                            setInstalledState(prev => ({ ...prev, font: true }));
                          } else {
                            setFontResult(`실패: ${data.error}`);
                          }
                        } catch {
                          setFontResult("서버 오류");
                        } finally {
                          setFontActionLoading(false);
                          if (fontInputRef.current) fontInputRef.current.value = "";
                        }
                      }}
                    />
                    <Button variant="primary" size="sm" onClick={() => fontInputRef.current?.click()} loading={fontActionLoading} className="font-bold">
                      파일 선택
                    </Button>
                  </div>
                </div>
                {fontResult && (
                  <p className="text-[13px] font-bold px-1 animate-fade-in" style={{ color: fontResult.includes("실패") ? "#d93025" : "#1e8e3e" }}>
                    {fontResult}
                  </p>
                )}
              </div>

              {/* 블루투스 설정 */}
              {installedState.bt && (
                <div className="space-y-4">
                  <SectionDivider label="블루투스 제어" />
                  <div
                    className="flex items-center justify-between p-4 bg-black/[0.03] border border-black/5"
                  >
                    <div>
                      <p className="text-[16px] font-bold text-black">키보드 재설정</p>
                      <p className="text-[13px] font-medium opacity-50 mt-0.5">다시 스캔하여 다른 키보드를 연결합니다.</p>
                    </div>
                    <Button variant="primary" size="sm" onClick={() => router.push("/bluetooth?mode=manage")} className="font-bold">
                      설정 열기
                    </Button>
                  </div>
                  <BluetoothPowerControl ip={state.ip} password={state.password} />
                </div>
              )}

              {/* 진단 섹션 */}
              <DiagnosisPanel
                ip={state.ip}
                password={state.password}
                title="시스템 진단"
                subtitle="문제 원인 확인 및 상태 점검"
              />
          </div>
        </div>

        <div className="flex justify-end pt-8 stagger-2">
          <Button onClick={() => router.push(returnPath)} size="lg" className="px-16 font-bold" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6" /></svg>}>
            처음으로
          </Button>
        </div>
      </div>
    </div>
  );
}
