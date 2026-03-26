"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
import { useSetup } from "@/lib/store";
import { useGuard } from "@/lib/useGuard";
import { ensureSshSession } from "@/lib/client/sshSession";

interface BtDevice {
  address: string;
  name: string;
  icon?: string;
}

type Phase = "scan" | "pair";
type ScanStatus = "idle" | "scanning" | "scanned" | "bt_error";
type PairStatus =
  | "idle"
  | "pairing"
  | "waiting_passkey"
  | "passkey"
  | "checking"
  | "paired"
  | "failed";

function isKeyboardDevice(device: BtDevice): boolean {
  if (!device.icon) return false;
  return device.icon.includes("keyboard") || device.icon.includes("input-keyboard");
}

function isLikelyKeyboard(device: BtDevice): boolean {
  if (isKeyboardDevice(device)) return true;
  const name = device.name.toLowerCase();
  return name.includes("keyboard") || name.includes("keys") || name.includes("keychron") || name.includes("hhkb") || name.includes("magic keyboard") || name.includes("k380") || name.includes("k780") || name.includes("mx keys");
}

export default function BluetoothPage() {
  const allowed = useGuard();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state, setState } = useSetup();
  const isManageMode = searchParams.get("mode") === "manage";
  const [phase, setPhase] = useState<Phase>("scan");
  const [scanStatus, setScanStatus] = useState<ScanStatus>("idle");
  const [pairStatus, setPairStatus] = useState<PairStatus>("idle");
  const [devices, setDevices] = useState<BtDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<BtDevice | null>(null);
  const [passkey, setPasskey] = useState("");
  const [, setPairLogs] = useState<string[]>([]);
  const [, setScanLogs] = useState<string[]>([]);
  const [pairSuccessName, setPairSuccessName] = useState("");
  const [removing, setRemoving] = useState(false);
  const [removeResult, setRemoveResult] = useState<string | null>(null);
  const [btError, setBtError] = useState<string | null>(null);
  const [enterKeyConfirmed, setEnterKeyConfirmed] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pairStatusRef = useRef<PairStatus>("idle");
  const pairTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    pairStatusRef.current = pairStatus;
  }, [pairStatus]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      if (pairTimeoutRef.current) clearTimeout(pairTimeoutRef.current);
    };
  }, []);

  const startScan = async () => {
    setScanStatus("scanning");
    setDevices([]);
    setSelectedDevice(null);
    setRemoveResult(null);
    setBtError(null);
    setScanLogs([]);

    try {
      await ensureSshSession(state.ip, state.password);
    } catch {
      setBtError("SSH 세션을 준비할 수 없습니다.");
      setScanStatus("bt_error");
      return;
    }

    const es = new EventSource("/api/bluetooth/scan");
    eventSourceRef.current = es;

    const scanTimeout = setTimeout(() => {
      if (es.readyState !== EventSource.CLOSED) {
        es.close();
        setScanStatus("scanned");
      }
    }, 50000);

    es.addEventListener("log", (e) => {
      const data = JSON.parse(e.data);
      setScanLogs((prev) => [...prev, data.line]);
    });

    es.addEventListener("bt_error", (e) => {
      const data = JSON.parse(e.data);
      setBtError(data.message);
      setScanStatus("bt_error");
      clearTimeout(scanTimeout);
      es.close();
    });

    es.addEventListener("device", (e) => {
      const data = JSON.parse(e.data);
      setDevices((prev) => {
        if (prev.some((d) => d.address === data.address)) return prev;
        return [...prev, { address: data.address, name: data.name, icon: data.icon }];
      });
    });

    es.addEventListener("complete", () => {
      setScanStatus("scanned");
      es.close();
    });

    es.addEventListener("error", () => {
      setScanStatus("scanned");
      es.close();
    });

    es.onerror = () => {
      setScanStatus("scanned");
      es.close();
    };
  };

  const startPair = async () => {
    if (!selectedDevice) return;
    setPhase("pair");
    setPairStatus("pairing");
    setPasskey("");
    setPairLogs([]);
    setPairSuccessName("");
    setEnterKeyConfirmed(false);

    try {
      await ensureSshSession(state.ip, state.password);
    } catch {
      setPairLogs((prev) => [...prev, "ERROR: SSH 세션을 준비할 수 없습니다."]);
      setPairStatus("failed");
      return;
    }

    const params = new URLSearchParams({
      address: selectedDevice.address,
      name: selectedDevice.name,
    });

    const es = new EventSource(`/api/bluetooth/pair?${params}`);
    eventSourceRef.current = es;

    if (pairTimeoutRef.current) clearTimeout(pairTimeoutRef.current);
    pairTimeoutRef.current = setTimeout(() => {
      const s = pairStatusRef.current;
      if (s === "pairing" || s === "waiting_passkey") {
        setPairLogs((prev) => [
          ...prev,
          "WARNING: 패스키가 나타나지 않습니다.",
          "키보드가 페어링 모드인지 확인하세요.",
        ]);
        setPairStatus("failed");
        es.close();
      }
    }, 45000);

    es.addEventListener("waiting_passkey", () => {
      setPairStatus("waiting_passkey");
    });

    es.addEventListener("passkey", (e) => {
      const data = JSON.parse(e.data);
      setPasskey(data.passkey);
      setPairStatus("passkey");
      if (pairTimeoutRef.current) clearTimeout(pairTimeoutRef.current);
    });

    es.addEventListener("log", (e) => {
      const data = JSON.parse(e.data);
      setPairLogs((prev) => [...prev, data.line]);
    });

    es.addEventListener("paired", (e) => {
      if (pairTimeoutRef.current) clearTimeout(pairTimeoutRef.current);
      const data = JSON.parse(e.data);
      if (data.success) {
        setState({
          btDeviceAddress: selectedDevice.address,
          btDeviceName: selectedDevice.name,
        });
        setPairSuccessName(selectedDevice.name);
        setPairStatus("paired");
      } else {
        setPairStatus("failed");
      }
      es.close();
    });

    es.addEventListener("complete", () => {
      es.close();
    });

    es.addEventListener("error", (e) => {
      const s = pairStatusRef.current;
      if (s === "passkey" || s === "checking" || s === "paired") return;
      try {
        const data = JSON.parse((e as MessageEvent).data);
        setPairLogs((prev) => [...prev, `ERROR: ${data.message}`]);
        setPairStatus("failed");
        es.close();
      } catch {
        // Native SSE error
      }
    });

    es.onerror = () => {
      const s = pairStatusRef.current;
      if (s === "passkey" || s === "checking" || s === "paired") return;
      if (es.readyState === EventSource.CLOSED) {
        setPairStatus("failed");
        setPairLogs((prev) => [...prev, "ERROR: 연결이 종료되었습니다."]);
      }
    };
  };

  const cancelPairing = () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (pairTimeoutRef.current) clearTimeout(pairTimeoutRef.current);
    setPhase("scan");
    setPairStatus("idle");
    setPairLogs([]);
    setPasskey("");
  };

  const checkPairStatus = useCallback(async () => {
    if (!selectedDevice) return;
    setPairStatus("checking");

    try {
      await ensureSshSession(state.ip, state.password);
    } catch {
      setPairStatus("failed");
      setPairLogs((prev) => [...prev, "ERROR: SSH 세션을 준비할 수 없습니다."]);
      return;
    }

    const params = new URLSearchParams({
      address: selectedDevice.address,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`/api/bluetooth/pair-status?${params}`);
        const data = await res.json();
        if (data.ready) {
          eventSourceRef.current?.close();
          setState({
            btDeviceAddress: selectedDevice.address,
            btDeviceName: selectedDevice.name,
          });
          setPairSuccessName(selectedDevice.name);
          setPairStatus("paired");
          return;
        }
      } catch {
        // retry
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    setPairStatus("failed");
  }, [selectedDevice, state.ip, state.password, setState]);

  const handleRetryPair = () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setPhase("scan");
    setPairStatus("idle");
    setPairLogs([]);
    setPasskey("");
  };

  const handleRemoveDevice = useCallback(
    async (address: string) => {
      setRemoving(true);
      setRemoveResult(null);
      try {
        const res = await fetch("/api/bluetooth/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ip: state.ip, password: state.password, address }),
        });
        const data = await res.json();
        if (data.success) {
          setRemoveResult("기기가 해제되었습니다.");
          setDevices((prev) => prev.filter((d) => d.address !== address));
          setSelectedDevice(null);
        } else {
          setRemoveResult(`해제 실패: ${data.error ?? "알 수 없는 오류"}`);
        }
      } catch {
        setRemoveResult("서버 오류가 발생했습니다.");
      } finally {
        setRemoving(false);
      }
    },
    [state.ip, state.password],
  );

  const canGoNext = pairStatus === "paired";

  if (!allowed) return null;

  return (
    <div className="animate-fade-in-up">
      {!isManageMode && <StepIndicator currentStep={5} />}

      <div className="space-y-10">
        <div>
          <h1
            className="text-[36px] font-bold leading-tight"
            style={{ color: "var(--text-primary)" }}
          >
            {isManageMode ? "블루투스 재설정" : "블루투스 키보드"}
          </h1>
          <p
            className="mt-3 text-[17px]"
            style={{ color: "var(--text-muted)" }}
          >
            {isManageMode
              ? "페어링 모드로 전환한 뒤 다시 검색하고 연결을 바꿀 수 있습니다."
              : "키보드를 페어링 모드로 설정한 후 검색하세요."}
          </p>
        </div>

        {/* 가이드 */}
        {phase === "scan" && scanStatus === "idle" && (
          <div
            className="text-[16px] space-y-3 p-6 rounded-xl stagger-1"
            style={{ backgroundColor: "var(--bg-secondary)", color: "var(--text-muted)" }}
          >
            <p><strong style={{ color: "var(--text-secondary)" }}>Magic Keyboard</strong> — 전원 스위치 껐다 켜기</p>
            <p><strong style={{ color: "var(--text-secondary)" }}>일반 키보드</strong> — BT 버튼 3초 길게 누르기</p>
            <p className="text-[14px] pt-2" style={{ color: "var(--warning)" }}>
              다른 기기에 연결된 키보드는 먼저 해제 후 페어링하세요.
            </p>
          </div>
        )}

        {/* 스캔 */}
        {phase === "scan" && (
          <>
            <Button
              onClick={startScan}
              loading={scanStatus === "scanning"}
              className="w-full stagger-2"
              size="lg"
            >
              {scanStatus === "scanning"
                ? "스캔 중..."
                : devices.length > 0
                  ? "다시 스캔"
                  : "스캔 시작"}
            </Button>

            {removeResult && (
              <p
                className="text-[14px]"
                style={{ color: removeResult.includes("실패") ? "var(--error)" : "var(--success)" }}
              >
                {removeResult}
              </p>
            )}

            {/* 키보드 목록 */}
            {devices.length > 0 && (() => {
              const keyboards = devices.filter(isLikelyKeyboard);
              return (
                <div className="space-y-4">
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
                    키보드 ({keyboards.length})
                  </span>

                  <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                    같은 이름이 여러 개 보이면 키보드의 다른 블루투스 프로파일일 수 있습니다. 지금 기기에서 사용하려는 주소를 선택하세요.
                  </p>

                  {keyboards.length === 0 ? (
                    <div
                      className="py-8 text-center rounded-xl"
                      style={{ backgroundColor: "var(--bg-secondary)" }}
                    >
                      <p className="text-[16px]" style={{ color: "var(--text-muted)" }}>
                        {devices.length}개 기기가 발견되었지만 키보드가 없습니다.
                      </p>
                      <p className="text-[14px] mt-2" style={{ color: "var(--text-muted)" }}>
                        키보드를 페어링 모드로 설정한 후 다시 스캔하세요.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {keyboards.map((device) => (
                        <button
                          key={device.address}
                          onClick={() => setSelectedDevice(device)}
                          className="w-full text-left py-5 px-6 rounded-xl transition-all card-interactive"
                          style={{
                            backgroundColor:
                              selectedDevice?.address === device.address
                                ? "var(--bg-card)"
                                : "transparent",
                            border: selectedDevice?.address === device.address
                              ? "2px solid var(--accent)"
                              : "2px solid var(--border-light)",
                          }}
                        >
                          <div className="flex items-center gap-4">
                            {/* 키보드 아이콘 */}
                            <svg
                              width="22"
                              height="22"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              style={{
                                color: selectedDevice?.address === device.address
                                  ? "var(--accent)"
                                  : "var(--text-muted)",
                                flexShrink: 0,
                              }}
                            >
                              <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
                              <line x1="6" y1="8" x2="6.01" y2="8" />
                              <line x1="10" y1="8" x2="10.01" y2="8" />
                              <line x1="14" y1="8" x2="14.01" y2="8" />
                              <line x1="18" y1="8" x2="18.01" y2="8" />
                              <line x1="6" y1="12" x2="6.01" y2="12" />
                              <line x1="18" y1="12" x2="18.01" y2="12" />
                              <line x1="8" y1="16" x2="16" y2="16" />
                            </svg>
                            <div className="min-w-0 flex-1">
                              <span className="text-[18px] font-semibold block" style={{ color: "var(--text-primary)" }}>
                                {device.name}
                              </span>
                              <span className="text-[12px] font-mono mt-1 block" style={{ color: "var(--text-muted)" }}>
                                {device.address}
                              </span>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {selectedDevice && keyboards.some((d) => d.address === selectedDevice.address) && (
                    <div className="flex gap-3 pt-2">
                      <Button onClick={startPair} className="flex-1" size="lg">
                        페어링
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => handleRemoveDevice(selectedDevice.address)}
                        loading={removing}
                      >
                        해제
                      </Button>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* BT 에러 */}
            {scanStatus === "bt_error" && btError && (
              <div
                className="p-6 rounded-xl"
                style={{ backgroundColor: "var(--error-light)", color: "var(--error)" }}
              >
                <p className="text-[17px] font-medium">블루투스 비활성화</p>
                <p className="text-[15px] mt-2" style={{ color: "var(--text-muted)" }}>
                  {btError}
                </p>
                <Button variant="secondary" size="sm" className="mt-4" onClick={startScan}>
                  다시 시도
                </Button>
              </div>
            )}

            {/* 기기 없음 */}
            {scanStatus === "scanned" && devices.length === 0 && (
              <p className="text-[17px] text-center py-12" style={{ color: "var(--text-muted)" }}>
                키보드를 찾지 못했습니다. 페어링 모드를 확인하세요.
              </p>
            )}
          </>
        )}

        {/* 페어링 */}
        {phase === "pair" && (
          <>
            {/* 패스키 */}
            {(pairStatus === "passkey" || pairStatus === "checking") && passkey && (
              <div className="text-center py-10 space-y-8" style={{ backgroundColor: "var(--bg-secondary)", borderRadius: "var(--radius-lg)", padding: "40px" }}>
                <p className="text-[14px] uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
                  키보드에서 아래 숫자를 입력하세요
                </p>
                <p
                  className="text-[56px] font-bold tracking-[0.4em] font-mono"
                  style={{ color: "var(--text-primary)" }}
                >
                  {passkey}
                </p>

                {/* 엔터키 안내 */}
                <p className="text-[15px]" style={{ color: "var(--text-muted)" }}>
                  숫자 입력 후 <strong style={{ color: enterKeyConfirmed ? "var(--success)" : "var(--error)" }}>Enter(Return)</strong> 키를 꼭 눌러주세요
                </p>

                {/* 확인 체크박스 */}
                <label className="inline-flex items-center gap-3 cursor-pointer select-none">
                  <div
                    className="flex items-center justify-center flex-shrink-0 transition-all"
                    style={{
                      width: "22px",
                      height: "22px",
                      backgroundColor: enterKeyConfirmed ? "var(--success)" : "transparent",
                      border: enterKeyConfirmed ? "none" : "2px solid var(--border)",
                      borderRadius: "6px",
                    }}
                  >
                    {enterKeyConfirmed && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  <input
                    type="checkbox"
                    checked={enterKeyConfirmed}
                    onChange={(e) => setEnterKeyConfirmed(e.target.checked)}
                    className="sr-only"
                  />
                  <span className="text-[15px] font-medium" style={{ color: enterKeyConfirmed ? "var(--success)" : "var(--text-secondary)" }}>
                    Enter 키를 눌렀습니다
                  </span>
                </label>

                <div className="flex justify-center gap-3">
                  <Button variant="ghost" onClick={cancelPairing}>
                    취소
                  </Button>
                  <Button
                    onClick={checkPairStatus}
                    disabled={pairStatus === "checking" || !enterKeyConfirmed}
                  >
                    {pairStatus === "checking" ? "확인 중..." : "입력 완료"}
                  </Button>
                </div>
              </div>
            )}

            {/* 페어링 중 */}
            {(pairStatus === "pairing" || pairStatus === "waiting_passkey") && (
              <div className="text-center py-14">
                <span className="inline-flex gap-1.5 mb-4" style={{ color: "var(--text-muted)" }}>
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "currentColor", animation: "dotBounce 1.4s ease-in-out infinite", animationDelay: `${i * 0.16}s` }} />
                  ))}
                </span>
                <p className="text-[17px]" style={{ color: "var(--text-secondary)" }}>
                  {pairStatus === "waiting_passkey" ? "요청 전송됨..." : "페어링 중..."}
                </p>
                {pairStatus === "waiting_passkey" && (
                  <p className="text-[15px] mt-2" style={{ color: "var(--text-muted)" }}>
                    잠시만 기다려 주세요.
                  </p>
                )}
                <div className="mt-6 flex justify-center gap-3">
                  <Button variant="ghost" onClick={cancelPairing}>
                    취소
                  </Button>
                  <Button variant="secondary" onClick={() => { cancelPairing(); startScan(); }}>
                    재스캔
                  </Button>
                </div>
              </div>
            )}

            {/* 성공 */}
            {pairStatus === "paired" && (
              <div
                className="p-6 rounded-xl flex items-center justify-between animate-fade-in"
                style={{ backgroundColor: "var(--success-light)" }}
              >
                <div>
                  <p className="text-[17px] font-medium" style={{ color: "var(--success)" }}>
                    페어링 성공
                  </p>
                  <p className="text-[15px] mt-1" style={{ color: "var(--text-muted)" }}>
                    {pairSuccessName} 등록 완료
                  </p>
                  <p className="text-[14px] mt-2" style={{ color: "var(--text-muted)" }}>
                    이후에는 필요할 때 자동으로 다시 연결됩니다.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (selectedDevice) handleRemoveDevice(selectedDevice.address);
                    handleRetryPair();
                  }}
                  loading={removing}
                >
                  다른 키보드
                </Button>
              </div>
            )}

            {/* 실패 */}
            {pairStatus === "failed" && (
              <div
                className="p-6 rounded-xl animate-fade-in"
                style={{ backgroundColor: "var(--error-light)" }}
              >
                <p className="text-[17px] font-medium" style={{ color: "var(--error)" }}>
                  페어링 실패
                </p>
                <p className="text-[15px] mt-2" style={{ color: "var(--text-muted)" }}>
                  페어링 모드를 확인하고 다시 시도하세요.
                </p>
                <div className="flex gap-3 mt-4">
                  <Button variant="secondary" onClick={handleRetryPair}>
                    재시도
                  </Button>
                  {selectedDevice && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        handleRemoveDevice(selectedDevice.address);
                        handleRetryPair();
                      }}
                      loading={removing}
                    >
                      해제 후 재시도
                    </Button>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* 네비게이션 */}
        <div className="flex justify-between pt-4">
          <Button
            variant="ghost"
            onClick={() => {
              if (phase === "pair" && pairStatus !== "paired" && pairStatus !== "failed") {
                cancelPairing();
              } else if (phase === "pair") {
                handleRetryPair();
              } else {
                router.push(isManageMode ? "/manage" : "/install");
              }
            }}
          >
            {phase === "pair" ? "스캔으로" : "이전"}
          </Button>
          <div className="flex gap-3">
            {!isManageMode && !canGoNext && (
              <Button variant="secondary" onClick={() => router.push(isManageMode ? "/manage" : "/complete")}>
                {isManageMode ? "설정 변경으로" : "건너뛰기"}
              </Button>
            )}
            <Button
              onClick={() => router.push(isManageMode ? "/manage" : "/complete")}
              disabled={!canGoNext}
              size="lg"
            >
              {isManageMode ? "설정 변경으로" : "다음"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
