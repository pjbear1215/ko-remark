import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

interface VerifyRequest {
  ip: string;
  password: string;
  hangul?: boolean;
  bt?: boolean;
}

interface CheckDefinition {
  name: string;
  command: string;
  requires?: "hangul" | "bt";
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
    requires: "hangul",
  },
  {
    name: "한글 입력 데몬",
    command: "systemctl is-active hangul-daemon 2>/dev/null || echo FAIL",
    requires: "hangul",
  },
  {
    name: "블루투스",
    command:
      `
        BTNXP_UART_OK=no
        BOOT_FIX_OK=no
        PRIVACY_OK=no
        FAST_CONNECTABLE_OK=no
        WAKE_RECONNECT_OK=no
        [ -f /etc/modules-load.d/btnxpuart.conf ] && BTNXP_UART_OK=yes
        # ConditionPathIsDirectory 라인이 주석처리(#) 되어있으면 OK
        if ! grep -q "^ConditionPathIsDirectory" /usr/lib/systemd/system/bluetooth.service 2>/dev/null; then
          BOOT_FIX_OK=yes
        fi
        if [ -f /etc/bluetooth/main.conf ]; then
          grep -qi "Privacy.*=.*device" /etc/bluetooth/main.conf && PRIVACY_OK=yes
          grep -qi "Privacy.*=.*off" /etc/bluetooth/main.conf && PRIVACY_OK=yes
          grep -qi "FastConnectable.*=.*true" /etc/bluetooth/main.conf && FAST_CONNECTABLE_OK=yes
        fi
        systemctl is-active rekoit-bt-wake-reconnect.service 2>/dev/null | grep -q active && WAKE_RECONNECT_OK=yes
        if [ "$BTNXP_UART_OK" = yes ] && [ "$BOOT_FIX_OK" = yes ] && [ "$PRIVACY_OK" = yes ] && [ "$FAST_CONNECTABLE_OK" = yes ] && [ "$WAKE_RECONNECT_OK" = yes ]; then
          echo OK
        else
          echo "FAIL: btnxpuart=$BTNXP_UART_OK boot_fix=$BOOT_FIX_OK privacy=$PRIVACY_OK fast_connectable=$FAST_CONNECTABLE_OK wake_reconnect=$WAKE_RECONNECT_OK"
        fi      `,
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
  const { ip, password, hangul = true, bt = true } = body;

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
    if (check.requires === "hangul" && !hangul) return false;
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
