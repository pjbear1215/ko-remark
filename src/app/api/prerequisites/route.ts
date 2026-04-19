import { NextResponse } from "next/server";
import { spawn } from "child_process";

import {
  buildBulkInstallCommand,
  buildSingleToolInstallCommand,
  detectPackageManager,
  getHostPlatform,
  getPackageManagerActionLabel,
  getPackageManagerBootstrapHint,
  getToolStatuses,
} from "@/lib/prerequisites";

async function getSnapshot() {
  const platform = getHostPlatform();
  const packageManager = await detectPackageManager();
  const tools = await getToolStatuses();
  const missingTools = tools.filter((tool) => !tool.installed);
  const allReady = missingTools.length === 0;

  return {
    tools,
    allReady,
    platform,
    packageManager: {
      label: packageManager.label,
      installed: packageManager.installed,
      canAutoInstall: packageManager.canAutoInstall,
      hint: allReady && !packageManager.installed
        ? "필수 도구가 이미 준비되어 있습니다."
        : packageManager.autoInstallHint,
      actionLabel: packageManager.installed ? null : getPackageManagerActionLabel(platform),
      bootstrapHint: getPackageManagerBootstrapHint(platform),
    },
    manualInstallCommand:
      missingTools.length > 0 && packageManager.id
        ? buildBulkInstallCommand(
            packageManager.id,
            missingTools.map((tool) => tool.command),
            true,
          )
        : "",
  };
}

// GET: 상태 확인 (폴링용, 빠르게 반환)
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await getSnapshot());
}

// POST: 보조 액션
export async function POST(request: Request): Promise<NextResponse> {
  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { action } = body;

  if (action === "open-brew-install") {
    const platform = getHostPlatform();
    if (platform.id !== "macos") {
      return NextResponse.json({ error: "macOS에서만 지원" }, { status: 400 });
    }
    try {
      const appleScript = [
        'tell application "Terminal"',
        "  activate",
        '  do script "/bin/bash -c \\"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\\""',
        "end tell",
      ].join("\n");

      await new Promise<void>((resolve, reject) => {
        const proc = spawn("osascript", ["-e", appleScript]);
        proc.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`osascript exit code ${code}`));
        });
        proc.on("error", reject);
      });
      return NextResponse.json({ success: true });
    } catch {
      return NextResponse.json(
        { error: "터미널을 열 수 없습니다" },
        { status: 500 },
      );
    }
  }

  if (action === "install-tools") {
    const packageManager = await detectPackageManager();
    if (!packageManager.id || !packageManager.installed) {
      return NextResponse.json(
        { error: "자동 설치용 패키지 매니저를 찾지 못했습니다" },
        { status: 400 },
      );
    }
    if (!packageManager.canAutoInstall) {
      return NextResponse.json(
        { error: "관리자 권한이 필요해 브라우저에서 자동 설치할 수 없습니다" },
        { status: 400 },
      );
    }

    const tools = await getToolStatuses();
    const results: Record<string, boolean> = {};
    for (const tool of tools) {
      if (tool.installed) {
        results[tool.command] = true;
        continue;
      }

      const command = buildSingleToolInstallCommand(packageManager.id, tool.command, false);
      if (!command) {
        results[tool.command] = false;
        continue;
      }

      try {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        await execAsync(command, {
          timeout: 300000,
          env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/local/go/bin` },
        });
        const refreshed = await getToolStatuses();
        results[tool.command] = refreshed.find((entry) => entry.command === tool.command)?.installed === true;
      } catch {
        results[tool.command] = false;
      }
    }

    return NextResponse.json({ results });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
