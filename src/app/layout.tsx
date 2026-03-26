import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "ReKoIt",
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
                className="text-[15px] font-bold tracking-[0.18em] uppercase"
                style={{ color: "var(--text-primary)" }}
              >
                ReKoIt
              </p>
              <p className="text-[12px] mt-2" style={{ color: "var(--text-muted)" }}>
                리마커블 한글 입력 + 블루투스 도구
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
              USB guided flow
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
