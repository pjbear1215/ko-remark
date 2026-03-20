"use client";

// 단계 표시 도트-앤-라인 프로그레스 인디케이터
const steps = ["시작", "준비", "연결", "선택", "설치", "BT", "완료"];

interface StepIndicatorProps {
  currentStep: number;
}

export default function StepIndicator({ currentStep }: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-between mb-14 px-2 relative">
      {/* 연결선 배경 (전체, 미래 구간 점선) */}
      <div
        className="absolute top-[10px] left-0 right-0 h-[2px]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, var(--border-light) 0px, var(--border-light) 4px, transparent 4px, transparent 8px)",
          opacity: 0.55,
        }}
      />
      {/* 연결선 진행 (완료 구간 실선) */}
      <div
        className="absolute top-[10px] left-0 h-[2px]"
        style={{
          width: `${(Math.min(currentStep, steps.length - 1) / (steps.length - 1)) * 100}%`,
          background: "linear-gradient(90deg, rgba(10,132,255,0.75), rgba(10,132,255,0.35))",
          transition: "width var(--transition-base)",
        }}
      />
      {steps.map((label, i) => (
        <div
          key={label}
          className="flex flex-col items-center"
        >
          {/* 도트 */}
          {i < currentStep ? (
            // 완료 단계: 체크마크 원형
            <div
              className="relative z-10"
              style={{
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                backgroundColor: "var(--apple-blue)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all var(--transition-spring)",
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          ) : i === currentStep ? (
            // 현재 단계: 큰 링 + 펄스 애니메이션
            <div
              className="relative z-10"
              style={{
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                backgroundColor: "var(--apple-blue)",
                animation: "ringPulse 2s ease-in-out infinite",
                transition: "all var(--transition-spring)",
              }}
            />
          ) : (
            // 미래 단계: 점선 테두리 원형
            <div
              className="relative z-10"
              style={{
                width: "14px",
                height: "14px",
                borderRadius: "50%",
                border: "1.5px dashed rgba(126, 120, 111, 0.5)",
                backgroundColor: "transparent",
                transition: "all var(--transition-spring)",
              }}
            />
          )}
          {/* 라벨 */}
          <span
            className="text-[13px] mt-2 whitespace-nowrap"
            style={{
              color:
                i === currentStep
                  ? "var(--text-primary)"
                  : i < currentStep
                    ? "var(--text-secondary)"
                    : "rgba(126, 120, 111, 0.72)",
              fontWeight:
                i === currentStep ? 600 : i < currentStep ? 500 : 400,
              transition: "color var(--transition-base)",
            }}
          >
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}
