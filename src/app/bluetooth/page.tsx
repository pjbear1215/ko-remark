"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
import TerminalOutput from "@/components/TerminalOutput";
import { useSetup } from "@/lib/store";
import { useGuard } from "@/lib/useGuard";
import { ensureSshSession } from "@/lib/client/sshSession";

interface BtDevice { address: string; name: string; }
type ScanStatus = "idle" | "preparing" | "ready_to_scan" | "scanning" | "scanned" | "bt_error";

export default function BluetoothPage() {
  const allowed = useGuard();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state, setState } = useSetup();
  const isManageMode = searchParams.get("mode") === "manage";
  
  const [phase, setPhase] = useState<"scan" | "pair">("scan");
  const [scanStatus, setScanStatus] = useState<ScanStatus>("idle");
  const [pairStatus, setPairStatus] = useState<"idle" | "pairing" | "passkey" | "paired" | "failed">("idle");
  const [devices, setDevices] = useState<BtDevice[]>([]);
  const [passkey, setPasskey] = useState("");
  const [allLogs, setAllLogs] = useState<string[]>([]);
  const [pairSuccessName, setPairSuccessName] = useState("");
  const [btError, setBtError] = useState<string | null>(null);
  const [enterKeyConfirmed, setEnterKeyConfirmed] = useState(false);
  const [currentStatus, setCurrentStatus] = useState("준비 중...");
  const [dotCount, setDotCount] = useState(0);
  
  const eventSourceRef = useRef<EventSource | null>(null);
  const monitorSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (["preparing", "scanning", "pairing"].includes(scanStatus) || pairStatus === "pairing") {
      interval = setInterval(() => setDotCount((prev) => (prev + 1) % 4), 500);
    } else { setDotCount(0); }
    return () => clearInterval(interval);
  }, [scanStatus, pairStatus]);

  const dots = ".".repeat(dotCount).padEnd(3, "\u00A0");

  const startMonitor = useCallback(() => {
    if (monitorSourceRef.current) return;
    const ms = new EventSource("/api/bluetooth/logs");
    monitorSourceRef.current = ms;
    ms.addEventListener("log", (e) => setAllLogs((prev) => [...prev, JSON.parse(e.data).line]));
    ms.onerror = () => { ms.close(); monitorSourceRef.current = null; setTimeout(startMonitor, 5000); };
  }, []);

  const stopMonitor = useCallback(() => { monitorSourceRef.current?.close(); monitorSourceRef.current = null; }, []);

  useEffect(() => { if (allowed) startMonitor(); return () => { eventSourceRef.current?.close(); monitorSourceRef.current?.close(); }; }, [allowed, startMonitor]);

  const handlePrepare = async () => {
    stopMonitor();
    setScanStatus("preparing");
    setCurrentStatus("블루투스 환경 준비 중...");
    setBtError(null);
    setDevices([]);
    setAllLogs((prev) => [...prev, "--- 스캔 환경 준비 시작 ---"]);
    try {
      await ensureSshSession(state.ip, state.password);
      const res = await fetch("/api/bluetooth/scan/prepare", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setScanStatus("ready_to_scan");
        setAllLogs((prev) => [...prev, "SUCCESS: 어댑터 준비 완료"]);
      } else { throw new Error(); }
    } catch {
      setBtError("어댑터 준비 실패. 다시 시도해 주세요.");
      setScanStatus("bt_error");
      startMonitor();
    }
  };

  const handleScan = async () => {
    setScanStatus("scanning");
    setCurrentStatus("주변 기기 검색 중...");
    setAllLogs((prev) => [...prev, "--- 기기 검색 시작 ---"]);
    const es = new EventSource("/api/bluetooth/scan");
    eventSourceRef.current = es;
    es.addEventListener("device", (e) => {
      const data = JSON.parse(e.data);
      setDevices((prev) => {
        if (prev.some((d) => d.address.toLowerCase() === data.address.toLowerCase())) return prev;
        setAllLogs((p) => [...p, `FOUND: ${data.name} (${data.address})`]);
        return [...prev, { address: data.address, name: data.name }];
      });
    });
    es.addEventListener("complete", () => { setScanStatus("scanned"); es.close(); startMonitor(); });
    es.onerror = () => { setScanStatus("scanned"); es.close(); startMonitor(); };
  };

  const startPair = async (device: BtDevice) => {
    stopMonitor();
    setPhase("pair");
    setPairStatus("pairing");
    setCurrentStatus("페어링 시작 중...");
    setAllLogs((prev) => [...prev, "", `--- 페어링 시도: ${device.name} ---`]);
    try {
      const es = new EventSource(`/api/bluetooth/pair?address=${device.address}&name=${encodeURIComponent(device.name)}`);
      eventSourceRef.current = es;
      es.addEventListener("status", (e) => {
        const data = JSON.parse(e.data);
        setCurrentStatus(data.message);
      });
      es.addEventListener("passkey", (e) => { 
        setPasskey(JSON.parse(e.data).passkey); 
        setPairStatus("passkey"); 
      });
      es.addEventListener("log", (e) => setAllLogs((prev) => [...prev, JSON.parse(e.data).line]));
      es.addEventListener("paired", (e) => {
        const data = JSON.parse(e.data);
        if (data.success) {
          setState({ btDeviceAddress: device.address, btDeviceName: device.name });
          setPairSuccessName(device.name);
          setPairStatus("paired");
          setCurrentStatus("연결 완료");
        } else { 
          setPairStatus("failed"); 
          setCurrentStatus("페어링 실패");
        }
        es.close(); startMonitor();
      });
      es.onerror = () => { 
        setPairStatus("failed"); 
        setCurrentStatus("연결 중 오류 발생");
        es.close(); 
        startMonitor(); 
      };
    } catch { 
      setPairStatus("failed"); 
      setCurrentStatus("페어링 실패");
      startMonitor(); 
    }
  };

  if (!allowed) return null;

  return (
    <div className="animate-fade-in-up">
      {!isManageMode && <StepIndicator currentStep={5} />}
      <div className="space-y-6">
        <h1 className="text-[36px] font-bold">블루투스 키보드</h1>
        
        <div className="stagger-1">
          <div className="operator-card operator-card-strong" style={{ padding: "24px", border: "1.5px solid #000000" }}>
            <div className="space-y-6">
              
              <div className="p-5" style={{ backgroundColor: "#f0f0f0", borderLeft: "4px solid #000000" }}>
                {scanStatus === "idle" && <p className="font-bold">1. 스캔 준비 버튼을 눌러 블루투스를 활성화하세요.</p>}
                {scanStatus === "preparing" && <p className="font-bold text-[#0071e3]">블루투스 환경 준비 중{dots}</p>}
                {scanStatus === "ready_to_scan" && (
                  <div className="space-y-2 animate-pulse">
                    <p className="font-bold text-[18px]" style={{ color: "#0071e3" }}>⚡ 준비 완료! 이제 키보드 페어링 버튼을 누르세요</p>
                    <p className="text-[15px]">키보드 조작 후 아래 [검색 시작] 버튼을 눌러주세요.</p>
                  </div>
                )}
                {scanStatus === "scanning" && <p className="font-bold text-[#0071e3]">2. 기기 검색 중{dots}</p>}
                {pairStatus === "paired" && <p className="font-bold text-[#1e8e3e]">연결 성공: {pairSuccessName}</p>}
                {pairStatus === "failed" && <p className="font-bold text-[#d93025]">연결 실패: 키보드를 페어링 모드로 두고 다시 시도하세요.</p>}
              </div>

              {phase === "scan" && (
                <div className="space-y-6">
                  {["idle", "scanned", "bt_error"].includes(scanStatus) ? (
                    <Button onClick={handlePrepare} className="w-full font-bold" size="lg">스캔 준비 시작</Button>
                  ) : scanStatus === "ready_to_scan" ? (
                    <Button onClick={handleScan} className="w-full font-bold" size="lg" style={{ backgroundColor: "#0071e3" }}>기기 검색 시작</Button>
                  ) : null}

                  {devices.length > 0 && (
                    <div className="grid gap-3">
                      <p className="text-[12px] font-bold opacity-40">검색된 기기</p>
                      {devices.map((d) => (
                        <button key={d.address} onClick={() => void startPair(d)} className="w-full text-left p-4 bg-black/[0.03] border-2 border-transparent hover:border-black/10 flex items-center gap-4 group transition-all active:scale-[0.98]">
                          <div className="w-10 h-10 bg-black text-white flex items-center justify-center shrink-0">⌨️</div>
                          <div className="flex-1 truncate"><span className="font-bold block truncate">{d.name}</span><span className="text-[12px] opacity-50">{d.address}</span></div>
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <span className="text-[13px] font-bold text-[#0071e3]">연결하기 →</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {phase === "pair" && (
                <div className="space-y-8 py-4">
                  {pairStatus === "pairing" && (
                    <div className="text-center space-y-4 py-8 animate-pulse">
                      <div className="flex items-center justify-center gap-2">
                        <span className="text-[24px] font-bold text-black">{currentStatus}</span>
                        <span className="flex gap-1">
                          <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
                          <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
                          <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
                        </span>
                      </div>
                      <p className="text-[15px] text-muted">리마커블 기기와 블루투스 연결을 구성하고 있습니다.</p>
                    </div>
                  )}

                  {pairStatus === "passkey" && (
                    <div className="text-center py-6 space-y-8 animate-fade-in">
                      <div className="space-y-2">
                        <p className="text-[13px] font-bold opacity-40 tracking-widest">KEYBOARD PASSKEY</p>
                        <p className="text-[64px] font-bold font-mono tracking-[0.2em] text-[#0071e3]">{passkey}</p>
                      </div>
                      <div className="p-5 bg-black/[0.03] space-y-4">
                        <p className="text-[16px] font-bold">키보드에서 위 숫자를 입력하고 <span className="underline">Enter</span>를 누르세요.</p>
                        <label className="inline-flex items-center gap-3 cursor-pointer p-2 hover:bg-black/5 transition-colors rounded">
                          <input type="checkbox" checked={enterKeyConfirmed} onChange={(e) => setEnterKeyConfirmed(e.target.checked)} className="w-5 h-5 accent-black" />
                          <span className="font-bold text-[15px]">숫자 입력 후 Enter를 눌렀습니다</span>
                        </label>
                      </div>
                    </div>
                  )}

                  {pairStatus === "failed" && (
                    <div className="text-center py-8 space-y-6">
                      <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                      </div>
                      <div className="space-y-2">
                        <p className="text-[20px] font-bold">페어링에 실패했습니다</p>
                        <p className="text-[15px] text-muted">키보드가 페어링 모드인지 확인하고 다시 시도해 주세요.</p>
                      </div>
                      <Button variant="secondary" onClick={() => setPhase("scan")} className="w-full">기기 다시 검색하기</Button>
                    </div>
                  )}

                  {pairStatus === "paired" && (
                    <div className="text-center py-8 space-y-6 animate-fade-in">
                      <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                      </div>
                      <div className="space-y-2">
                        <p className="text-[20px] font-bold">연결 성공!</p>
                        <p className="text-[15px] text-muted">이제 리마커블에서 블루투스 키보드를 사용할 수 있습니다.</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="pt-4 border-t border-black/5">
                <TerminalOutput lines={allLogs} maxHeight="160px" title="Bluetooth Operation Log" />
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-between pt-4">
          <Button variant="ghost" onClick={() => phase === "pair" ? setPhase("scan") : router.push("/install")}>이전</Button>
          <Button onClick={() => router.push(isManageMode ? "/manage" : "/complete")} disabled={pairStatus !== "paired"} size="lg" className="px-12 font-bold">다음 단계로</Button>
        </div>
      </div>
    </div>
  );
}
