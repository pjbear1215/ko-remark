"use client";

// 단계 표시 도트-앤-라인 프로그레스 인디케이터
const steps = ["시작", "준비", "연결", "선택", "설치", "BT", "완료"];

interface StepIndicatorProps {
  currentStep: number;
}

export default function StepIndicator({ currentStep }: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-between mb-6 px-2 relative">
      {/* 연결선 배경 (전체) */}
      <div
        className="absolute top-[10px] left-0 right-0 h-[1.5px]"
        style={{
          backgroundColor: "#e0e0e0",
        }}
      />
      {/* 연결선 진행 (완료 구간) */}
      <div
        className="absolute top-[10px] left-0 h-[1.5px]"
        style={{
          width: `${(Math.min(currentStep, steps.length - 1) / (steps.length - 1)) * 100}%`,
          backgroundColor: "#000000",
          transition: "width 0.4s ease-out",
        }}
      />
      {steps.map((label, i) => (
        <div
          key={label}
          className="flex flex-col items-center"
        >
          {/* 도트 */}
          {i < currentStep ? (
            // 완료 단계: 검정색 원 + 흰색 체크
            <div
              className="relative z-10"
              style={{
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                backgroundColor: "#000000",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.3s ease",
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          ) : i === currentStep ? (
            // 현재 단계: 검정색 테두리 원
            <div
              className="relative z-10"
              style={{
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                backgroundColor: "#ffffff",
                border: "2.5px solid #000000",
                transition: "all 0.3s ease",
              }}
            />
          ) : (
            // 미래 단계: 옅은 회색 작은 원
            <div
              className="relative z-10"
              style={{
                width: "14px",
                height: "14px",
                borderRadius: "50%",
                backgroundColor: "#e0e0e0",
                transition: "all 0.3s ease",
              }}
            />
          )}
          {/* 라벨 */}
          <span
            className="text-[12px] mt-2.5 font-bold uppercase tracking-widest"
            style={{
              color: i === currentStep ? "#000000" : i < currentStep ? "#666666" : "#bbbbbb",
              transition: "color 0.3s ease",
            }}
          >
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}
