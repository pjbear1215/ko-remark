"use client";

import type { ReactNode } from "react";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

// 커스텀 스타일 체크박스 컴포넌트
// 네이티브 input은 sr-only로 숨기고 접근성 유지
export default function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
}: CheckboxProps): ReactNode {
  return (
    <label
      className={`flex items-start gap-5 cursor-pointer w-full transition-all ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      {/* 체크박스 시각 요소: 설치 전 필수 확인 스타일 (w-6 h-6) */}
      <div
        className={`mt-0.5 w-6 h-6 shrink-0 border-2 flex items-center justify-center transition-colors ${
          checked ? "bg-[var(--success)] border-[var(--success)]" : "border-gray-300"
        }`}
        style={{ borderRadius: "0px" }}
      >
        {checked && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>
      {/* 스크린 리더용 숨겨진 네이티브 input */}
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="sr-only"
      />
      <div className="flex flex-col">
        <span
          className={`text-[16px] font-bold leading-tight transition-colors ${checked ? "text-[var(--success)]" : "text-[var(--text-primary)]"}`}
        >
          {label}
        </span>
        {description && (
          <span
            className="text-[12px] text-[var(--text-muted)] mt-2 leading-relaxed font-medium"
          >
            {description}
          </span>
        )}
      </div>
    </label>
  );
}
