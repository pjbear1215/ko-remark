import { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

export default function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  children,
  disabled,
  className = "",
  style,
  ...props
}: ButtonProps): ReactNode {
  const base =
    "inline-flex items-center justify-center font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--accent)] cursor-pointer transition-all duration-200";

  const variants = {
    primary:
      "bg-[#000000] text-[#ffffff] border border-[#000000] hover:bg-[#333333] disabled:opacity-40",
    secondary:
      "bg-transparent text-[#000000] border border-[#000000] hover:bg-[#f6f6f6] disabled:opacity-40",
    ghost:
      "bg-transparent text-[#000000] hover:bg-[#f6f6f6] border border-transparent hover:border-[#000000] disabled:opacity-40",
    danger:
      "bg-transparent text-[#ff3b30] hover:bg-[#fff5f5] border border-transparent hover:border-[#ff3b30] disabled:opacity-40",
  };

  const borderRadii: Record<string, string> = {
    primary: "6px",
    secondary: "6px",
    ghost: "6px",
    danger: "6px",
  };

  const sizes = {
    sm: "text-[14px]",
    md: "text-[15px]",
    lg: "text-[16px]",
  };

  const sizePaddings: Record<string, React.CSSProperties> = {
    sm: { padding: "8px 16px" },
    md: { padding: "10px 22px" },
    lg: { padding: "12px 28px" },
  };

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      style={{
        borderRadius: borderRadii[variant],
        ...sizePaddings[size],
        ...(style as React.CSSProperties || {}),
      }}
      {...props}
    >
      {loading ? (
        <span className="flex items-center justify-center gap-1.5 py-0.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-current"
              style={{
                animation: "dotBounce 1.4s ease-in-out infinite",
                animationDelay: `${i * 0.16}s`,
              }}
            />
          ))}
        </span>
      ) : (
        <>
          {icon && <span className="mr-2 inline-flex" style={{ color: "inherit" }}>{icon}</span>}
          <span style={{ color: "inherit" }}>{children}</span>
        </>
      )}
    </button>
  );
}
