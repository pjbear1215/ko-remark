import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "REKOIT",
  description: "reMarkable 한글 입력 + 블루투스 도구",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          as="style"
          crossOrigin="anonymous"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body className="min-h-screen">
        <div className="app-container">
          <header
            className="flex flex-wrap items-center justify-between gap-3"
            style={{ paddingBottom: "28px" }}
          >
            <div>
              <p
                className="text-[16px] font-bold tracking-[0.2em] uppercase"
                style={{ color: "var(--text-primary)" }}
              >
                REKOIT
              </p>
              <p className="text-[12px] mt-1 font-medium" style={{ color: "var(--text-muted)" }}>
                <strong style={{ color: "var(--text-primary)" }}>re</strong>Markable <strong style={{ color: "var(--text-primary)" }}>Ko</strong>rean <strong style={{ color: "var(--text-primary)" }}>I</strong>nput <strong style={{ color: "var(--text-primary)" }}>T</strong>oolkit
              </p>
            </div>

            <span
              className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em]"
              style={{
                color: "var(--text-secondary)",
                background: "rgba(255,255,255,0.72)",
                border: "1px solid var(--border-light)",
                padding: "8px 14px",
                borderRadius: "var(--radius-full)",
              }}
            >
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: "var(--accent-secondary)" }}
              />
              단계별 설치 안내
            </span>
          </header>

          <main>
            <Providers>{children}</Providers>
          </main>
        </div>
      </body>
    </html>
  );
}
