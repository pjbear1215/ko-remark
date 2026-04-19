import type { ReactNode } from "react";

interface SectionDividerProps {
  label: string;
}

// 섹션 구분 컴포넌트
// 모던 필 스타일 라벨 디자인 + 좌측 액센트 바
export default function SectionDivider({
  label,
}: SectionDividerProps): ReactNode {
  return (
    <div style={{ paddingTop: "4px", paddingBottom: "4px" }}>
      <div className="flex items-center gap-3">
        {/* 좌측 액센트 바 (블랙) */}
        <div
          className="flex-shrink-0"
          style={{
            width: "3px",
            height: "14px",
            backgroundColor: "#000000",
          }}
        />
        <span
          className="text-[12px] font-bold uppercase tracking-[0.15em] flex-shrink-0"
          style={{
            color: "#000000",
            letterSpacing: "0.15em",
          }}
        >
          {label}
        </span>
        <div
          className="flex-1"
          style={{
            height: "1.5px",
            backgroundColor: "rgba(0,0,0,0.08)",
          }}
        />
      </div>
    </div>
  );
}
