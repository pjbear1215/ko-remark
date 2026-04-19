"use client";

import { useEffect, useRef, useState } from "react";

interface TerminalOutputProps {
  lines: string[];
  maxHeight?: string;
  initiallyOpen?: boolean;
  showDownload?: boolean;
  onDownload?: () => void;
  title?: string;
}

// 터미널 라인 분류 함수
function classifyLine(line: string): "error" | "success" | "warn" | "info" | "heading" | "default" {
  if (line.startsWith("ERROR") || line.startsWith("FAIL")) return "error";
  if (line.startsWith("OK") || line.includes("\u2713")) return "success";
  if (line.startsWith("SKIP") || line.startsWith("WARN")) return "warn";
  if (line.startsWith("===")) return "heading";
  if (line.startsWith(">") || line.startsWith("$")) return "info";
  return "default";
}

// 라인 타입별 색상 매핑
const lineColors: Record<ReturnType<typeof classifyLine>, string> = {
  error: "#f87171",
  success: "#4ade80",
  warn: "#fbbf24",
  info: "#60a5fa",
  heading: "#818cf8",
  default: "#e2e8f0",
};

export default function TerminalOutput({
  lines,
  maxHeight = "280px",
  initiallyOpen = false,
  showDownload = false,
  onDownload,
  title = "Process Log",
}: TerminalOutputProps) {
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, isOpen]);

  return (
    <div className="space-y-3">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all"
        style={{
          backgroundColor: "var(--bg-secondary)",
          color: "var(--text-muted)",
          border: "1px solid var(--border-light)",
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease-in-out",
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        {isOpen ? "상세 로그 접기" : "상세 로그 보기"}
      </button>

      {isOpen && (
        <div
          className="overflow-hidden rounded-xl animate-fade-in relative group"
          style={{
            background: "linear-gradient(180deg, #171d28 0%, #1d2430 100%)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04), var(--shadow-md)",
          }}
        >
          {/* macOS 스타일 툴바 */}
          <div
            className="flex items-center gap-2 px-4 py-2.5"
            style={{
              backgroundColor: "rgba(23, 29, 40, 0.92)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
            }}
          >
            <div className="flex gap-1.5">
              <div className="w-[8px] h-[8px] rounded-full" style={{ backgroundColor: "#f87171" }} />
              <div className="w-[8px] h-[8px] rounded-full" style={{ backgroundColor: "#fbbf24" }} />
              <div className="w-[8px] h-[8px] rounded-full" style={{ backgroundColor: "#4ade80" }} />
            </div>
            <span className="text-[10px] ml-2 font-mono uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.3)" }}>
              {title}
            </span>
          </div>

          {/* 터미널 본문 */}
          <div
            className="font-mono text-[12px] leading-[20px] p-5 overflow-y-auto terminal-scroll"
            style={{
              color: "#e2e8f0",
              maxHeight,
              boxShadow: "inset 0 10px 18px -12px rgba(0,0,0,0.4)",
              paddingBottom: showDownload ? "48px" : "20px",
            }}
          >
            {lines.length === 0 ? (
              <span className="opacity-40 italic">대기 중...</span>
            ) : (
              lines.map((line, i) => {
                const type = classifyLine(line);
                return (
                  <div
                    key={i}
                    className="whitespace-pre-wrap"
                    style={{
                      color: lineColors[type],
                      fontWeight: type === "heading" ? 600 : 400,
                      animation: i >= lines.length - 10 ? "terminalLine 150ms ease-out both" : "none",
                    }}
                  >
                    {line}
                  </div>
                );
              })
            )}
            {/* 깜빡이는 커서 블록 */}
            {lines.length > 0 && (
              <span
                style={{
                  display: "inline-block",
                  width: "6px",
                  height: "12px",
                  backgroundColor: "#4ade80",
                  animation: "cursorBlink 1s step-end infinite",
                  marginLeft: "2px",
                  verticalAlign: "middle",
                }}
              />
            )}
            <div ref={bottomRef} />
          </div>

          {/* 로그 다운로드 버튼 (오른쪽 하단) */}
          {showDownload && onDownload && lines.length > 0 && (
            <button
              onClick={onDownload}
              className="absolute bottom-4 right-4 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all hover:scale-105 active:scale-95"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.1)",
                color: "rgba(255, 255, 255, 0.8)",
                border: "1px solid rgba(255, 255, 255, 0.15)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              로그 다운로드
            </button>
          )}
        </div>
      )}
    </div>
  );
}
