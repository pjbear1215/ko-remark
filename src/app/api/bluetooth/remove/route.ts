import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

function runSsh(
  ip: string,
  password: string,
  command: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SSHPASS: password, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };
    const proc = spawn(
      "sshpass",
      [
        "-e",
        "ssh",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=30",
        `root@${ip}`,
        command,
      ],
      { env },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else {
        const errorLines = stderr
          .split("\n")
          .filter((l) => !l.includes("Warning: Permanently added") && l.trim())
          .join("\n");
        reject(new Error(errorLines || `Exit code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json();
  const { ip, password, address } = body;

  if (!ip || !password || !address) {
    return NextResponse.json(
      { error: "ip, password, address 필수" },
      { status: 400 },
    );
  }

  if (!/^[\d.]+$/.test(ip)) {
    return NextResponse.json({ error: "잘못된 IP 형식" }, { status: 400 });
  }

  if (!/^[0-9A-Fa-f:]+$/.test(address)) {
    return NextResponse.json(
      { error: "잘못된 블루투스 주소" },
      { status: 400 },
    );
  }

  try {
    const removeScript = `
STATE_FILE="/home/root/rekoit/install-state.conf"
bluetoothctl disconnect ${address} 2>/dev/null || true
sleep 1
bluetoothctl untrust ${address} 2>/dev/null || true
bluetoothctl remove ${address} 2>/dev/null || true
if [ -f "$STATE_FILE" ] && grep -q '^BT_DEVICE_ADDRESS=${address}$' "$STATE_FILE" 2>/dev/null; then
  sed -i 's/^BT_DEVICE_ADDRESS=.*/BT_DEVICE_ADDRESS=/' "$STATE_FILE" 2>/dev/null || true
fi
echo "REMOVED:${address}"
`;
    const output = await runSsh(ip, password, removeScript);
    const removed = output.includes(`REMOVED:${address}`);
    return NextResponse.json({ success: removed, output: output.trim() });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
