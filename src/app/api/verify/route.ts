import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

interface VerifyRequest {
  ip: string;
  password: string;
  bt?: boolean;
}

interface CheckDefinition {
  name: string;
  command: string;
  requires?: "bt";
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const CHECKS: CheckDefinition[] = [
  {
    name: "한글 폰트",
    command:
      "test -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf && echo OK || echo FAIL",
  },
  {
    name: "BT 키보드 데몬",
    command: "systemctl is-active hangul-daemon 2>/dev/null || echo FAIL",
    requires: "bt",
  },
  {
    name: "블루투스",
    command:
      "hciconfig hci0 2>/dev/null | grep -q 'UP RUNNING' && echo OK || echo FAIL",
    requires: "bt",
  },
];

function runSshCheck(ip: string, password: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "sshpass",
      [
        "-e",
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10",
        `root@${ip}`,
        command,
      ],
      { env: { ...process.env, SSHPASS: password, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } },
    );

    let stdout = "";
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else resolve(stdout.trim() || "FAIL");
    });
    proc.on("error", reject);
    setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 15000);
  });
}

async function waitForSsh(ip: string, password: string, maxAttempts = 6): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await runSshCheck(ip, password, "echo OK");
      if (result === "OK") return true;
    } catch { /* 연결 실패 — 재시도 */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as VerifyRequest;
  const { ip, password, bt = true } = body;

  if (!ip || !password || !/^[\d.]+$/.test(ip)) {
    return NextResponse.json(
      { error: "Invalid parameters" },
      { status: 400 },
    );
  }

  // SSH 연결 대기 (설치 직후 xochitl/swupdate 재시작으로 USB 네트워크 일시 끊김)
  const sshReady = await waitForSsh(ip, password);
  if (!sshReady) {
    return NextResponse.json({
      results: [{ name: "SSH 연결", pass: false, detail: "기기에 연결할 수 없습니다" }],
    });
  }

  const activeChecks = CHECKS.filter((check) => {
    if (check.requires === "bt" && !bt) return false;
    return true;
  });

  const results: CheckResult[] = [];

  for (const check of activeChecks) {
    let output = "FAIL";
    // 실패 시 1회 재시도 (일시적 SSH 끊김 대응)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        output = await runSshCheck(ip, password, check.command);
        if (output.endsWith("OK") || output === "active") break;
      } catch { /* 재시도 */ }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    }

    results.push({
      name: check.name,
      pass: output.endsWith("OK") || output === "active",
      detail: output,
    });
  }

  return NextResponse.json({ results });
}
