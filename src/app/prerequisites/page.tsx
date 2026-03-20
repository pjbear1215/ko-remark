"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import StepIndicator from "@/components/StepIndicator";
import Button from "@/components/Button";
import ProgressBar from "@/components/ProgressBar";
import StatusCheck from "@/components/StatusCheck";
import { useGuard } from "@/lib/useGuard";

interface Tool {
  name: string;
  command: string;
  installed: boolean;
}

type InstallStatus = "idle" | "installing" | "complete" | "error";

interface ToolInstallState {
  label: string;
  status: "pending" | "installing" | "installed" | "failed";
  detail?: string;
}

export default function PrerequisitesPage() {
  const allowed = useGuard();
  const router = useRouter();
  const [tools, setTools] = useState<Tool[]>([]);
  const [allReady, setAllReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [brewMissing, setBrewMissing] = useState(false);
  const [brewInstallOpened, setBrewInstallOpened] = useState(false);
  const [installStatus, setInstallStatus] = useState<InstallStatus>("idle");
  const [toolStates, setToolStates] = useState<Record<string, ToolInstallState>>({});
  const [installProgress, setInstallProgress] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const autoNavigatedRef = useRef(false);

  useEffect(() => {
    if (!allowed) return;

    let cancelled = false;

    const loadTools = async (): Promise<void> => {
      try {
        const res = await fetch("/api/prerequisites");
        const data = (await res.json()) as {
          tools: Tool[];
          allReady: boolean;
          brewMissing: boolean;
        };
        if (cancelled) return;
        setTools(data.tools);
        setAllReady(data.allReady);
        setBrewMissing(data.brewMissing);
      } catch {
        if (cancelled) return;
      } finally {
        if (!cancelled) {
          setChecking(false);
        }
      }
    };

    void loadTools();

    return () => {
      cancelled = true;
    };
  }, [allowed]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!allowed || checking || !allReady || autoNavigatedRef.current) {
      return;
    }
    autoNavigatedRef.current = true;
    router.push("/connection");
  }, [allowed, checking, allReady, router]);

  if (!allowed) return null;

  const refreshTools = async (): Promise<void> => {
    setChecking(true);
    try {
      const res = await fetch("/api/prerequisites");
      const data = (await res.json()) as {
        tools: Tool[];
        allReady: boolean;
        brewMissing: boolean;
      };
      setTools(data.tools);
      setAllReady(data.allReady);
      setBrewMissing(data.brewMissing);
    } catch {
      // ignore
    } finally {
      setChecking(false);
    }
  };

  const openBrewInstall = async () => {
    setBrewInstallOpened(true);
    try {
      await fetch("/api/prerequisites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open-brew-install" }),
      });
    } catch {
      // ignore
    }
  };

  const startInstall = () => {
    setInstallStatus("installing");
    setInstallProgress(0);

    const missing = tools.filter((t) => !t.installed);
    const initial: Record<string, ToolInstallState> = {};
    for (const t of missing) {
      initial[t.command] = { label: t.name, status: "pending" };
    }
    setToolStates(initial);

    const es = new EventSource("/api/prerequisites/install");
    eventSourceRef.current = es;

    es.addEventListener("tool", (e) => {
      const data = JSON.parse(e.data);
      setToolStates((prev) => ({
        ...prev,
        [data.tool]: {
          label: data.label,
          status: data.status,
          detail: data.detail,
        },
      }));
      setInstallProgress(data.progress);

      if (data.status === "installed") {
        setTools((prev) =>
          prev.map((t) =>
            t.command === data.tool ? { ...t, installed: true } : t,
          ),
        );
      }
    });

    es.addEventListener("complete", () => {
      setInstallStatus("complete");
      setInstallProgress(100);
      setAllReady(true);
      es.close();
    });

    es.addEventListener("error", () => {
      setInstallStatus("error");
      es.close();
    });

    es.onerror = () => {
      if (installStatus === "installing") {
        setInstallStatus("error");
      }
      es.close();
    };
  };

  const hasMissingTools = tools.some((t) => !t.installed);

  return (
    <div className="animate-fade-in-up">
      <StepIndicator currentStep={1} />

      <div className="space-y-10">
        <div>
          <h1
            className="text-[36px] font-bold leading-tight"
            style={{ color: "var(--text-primary)" }}
          >
            사전 준비
          </h1>
          <p
            className="mt-3 text-[17px]"
            style={{ color: "var(--text-muted)" }}
          >
            필요한 도구를 확인하고 설치합니다.
          </p>
        </div>

        {/* Homebrew 미설치 */}
        {brewMissing && !checking && (
          <div
            className="p-6 rounded-xl"
            style={{
              backgroundColor: "var(--warning-light)",
              border: "1px solid var(--warning)",
            }}
          >
            <p className="text-[17px] font-medium" style={{ color: "var(--text-primary)" }}>
              Homebrew 설치가 필요합니다
            </p>
            <p className="text-[15px] mt-2" style={{ color: "var(--text-muted)" }}>
              터미널에서 안내에 따라 설치하세요.
            </p>
            <Button onClick={openBrewInstall} loading={brewInstallOpened} size="sm" className="mt-4">
              {brewInstallOpened ? "설치 진행 중..." : "Homebrew 설치"}
            </Button>
          </div>
        )}

        {/* 체크리스트 */}
        <div
          className="rounded-xl overflow-hidden stagger-1"
          style={{ backgroundColor: "var(--bg-card)", border: "1px solid var(--border-light)" }}
        >
          <StatusCheck
            label="Homebrew"
            status={checking ? "checking" : brewMissing ? "fail" : "pass"}
          />
          {tools.map((tool) => {
            const toolInstall = toolStates[tool.command];
            let status: "checking" | "pass" | "fail" = checking
              ? "checking"
              : tool.installed
                ? "pass"
                : "fail";
            let detail: string | undefined;

            if (toolInstall) {
              if (toolInstall.status === "installing") {
                status = "checking";
                detail = "설치 중...";
              } else if (toolInstall.status === "installed") {
                status = "pass";
              } else if (toolInstall.status === "failed") {
                status = "fail";
                detail = toolInstall.detail;
              }
            }

            return (
              <StatusCheck
                key={tool.name}
                label={tool.name}
                status={status}
                detail={detail}
              />
            );
          })}
        </div>

        {/* 설치 진행 바 */}
        {installStatus === "installing" && (
          <ProgressBar
            progress={installProgress}
            status="active"
            currentStep="도구 설치 중..."
          />
        )}

        {/* 설치 버튼 */}
        {!checking && !brewMissing && hasMissingTools && installStatus === "idle" && (
          <Button onClick={startInstall} className="w-full stagger-2" size="lg">
            설치 시작
          </Button>
        )}

        {/* 준비 완료 */}
        {allReady && !checking && (
          <div
            className="rounded-xl text-[17px] font-medium text-center animate-scale-in"
            style={{ backgroundColor: "var(--success-light)", color: "var(--success)", padding: "20px 24px" }}
          >
            모든 도구가 준비되었습니다.
          </div>
        )}

        {/* 설치 실패 */}
        {installStatus === "error" && (
          <div
            className="p-6 rounded-xl"
            style={{ backgroundColor: "var(--error-light)" }}
          >
            <p className="text-[17px] font-medium" style={{ color: "var(--error)" }}>
              일부 도구 설치에 실패했습니다.
            </p>
            <Button variant="secondary" size="sm" className="mt-4" onClick={startInstall}>
              재시도
            </Button>
          </div>
        )}

        {/* 네비게이션 */}
        <div className="flex justify-between pt-4 stagger-2">
          <Button variant="ghost" onClick={() => router.push("/")}>
            이전
          </Button>
          <div className="flex gap-3">
            {!allReady && installStatus !== "installing" && (
              <Button
                variant="secondary"
                onClick={refreshTools}
                loading={checking}
                size="sm"
              >
                재확인
              </Button>
            )}
            <Button
              onClick={() => router.push("/connection")}
              disabled={!allReady}
              size="lg"
            >
              다음
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
