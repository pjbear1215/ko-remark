import type { ReactNode } from "react";

interface ProgressBarProps {
  progress: number;
  status?: "active" | "complete" | "error";
  currentStep?: string;
}

// 진행률 표시 바 컴포넌트
// active 상태에서 쉬머 애니메이션, complete 상태에서 그라데이션, error 상태에서 단색 표시
export default function ProgressBar({
  progress,
  status = "active",
}: ProgressBarProps): ReactNode {
  const isComplete = progress >= 100 && status === "complete";

  // 상태별 채움 색상 (reMarkable 스타일: 그라데이션 제거, 단색 강조)
  const fillBackground =
    status === "error"
      ? "var(--error)"
      : status === "complete"
        ? "var(--accent)" // 성공 시 블랙으로 깔끔하게 마무리
        : "var(--accent-secondary)"; // 진행 중에는 세련된 블루

  return (
    <div className="w-full">
      <div className="flex justify-end items-center mb-2">
        <span
          className="text-[12px] font-bold font-mono tracking-tight"
          style={{
            color: status === "error" ? "var(--error)" : "var(--text-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {progress}%
        </span>
      </div>
      {/* 진행률 바 트랙 */}
      <div
        className="h-1.5 overflow-hidden rounded-full w-full"
        style={{
          backgroundColor: "var(--border-light)",
        }}
      >
        {/* 진행률 바 채움 영역 */}
        <div
          className="h-full relative transition-all duration-700 ease-out"
          style={{
            width: `${progress}%`,
            background: fillBackground,
            borderRadius: progress > 98 ? "inherit" : "9999px 0 0 9999px",
          }}
        >
          {/* 쉬머 오버레이 제거 (플랫한 디자인 지향) */}
        </div>
      </div>
    </div>
  );
}
