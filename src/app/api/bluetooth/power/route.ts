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

function updateBluetoothPowerStateScript(value: "0" | "1"): string {
  return `
STATE_FILE="/home/root/bt-keyboard/install-state.conf"
if [ -f "$STATE_FILE" ]; then
  if grep -q '^BLUETOOTH_POWER_ON=' "$STATE_FILE" 2>/dev/null; then
    sed -i 's/^BLUETOOTH_POWER_ON=.*/BLUETOOTH_POWER_ON=${value}/' "$STATE_FILE" 2>/dev/null || true
  else
    printf '\nBLUETOOTH_POWER_ON=${value}\n' >> "$STATE_FILE"
  fi
fi
`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json();
  const { ip, password, action } = body;

  if (!ip || !password || !["on", "off"].includes(action)) {
    return NextResponse.json(
      { error: "ip, password, action(on/off) 필수" },
      { status: 400 },
    );
  }

  if (!/^[\d.]+$/.test(ip)) {
    return NextResponse.json({ error: "잘못된 IP 형식" }, { status: 400 });
  }

  try {
    if (action === "on") {
      const script = `
modprobe btnxpuart 2>/dev/null || true
systemctl reset-failed bluetooth.service 2>/dev/null || true
systemctl start bluetooth.service 2>/dev/null || true
ACTIVE=inactive
POWERED=no
for i in 1 2 3 4 5 6; do
  ACTIVE=$(systemctl is-active bluetooth.service 2>/dev/null || true)
  if [ "$ACTIVE" = "active" ]; then
    bluetoothctl power on 2>/dev/null || true
    sleep 1
    POWERED=$(bluetoothctl show 2>/dev/null | grep "Powered:" | awk '{print $2}')
    [ -n "$POWERED" ] || POWERED=no
    [ "$POWERED" = "yes" ] && break
  fi
  sleep 1
done
echo "POWERED:$POWERED"
echo "ACTIVE:$ACTIVE"
if [ "$ACTIVE" = "active" ] && [ "$POWERED" = "yes" ]; then
${updateBluetoothPowerStateScript("1")}
fi
`;
      const output = await runSsh(ip, password, script);
      const powered = output.includes("POWERED:yes");
      const active = output.includes("ACTIVE:active");
      return NextResponse.json({ success: active && powered, powered, active });
    } else {
      const script = `
bluetoothctl power off 2>/dev/null || true
sleep 1
systemctl stop bluetooth.service 2>/dev/null || true
for i in 1 2 3 4 5; do
  ACTIVE=$(systemctl is-active bluetooth.service 2>/dev/null || true)
  [ "$ACTIVE" != "active" ] && break
  sleep 1
done
ACTIVE=$(systemctl is-active bluetooth.service 2>/dev/null || true)
echo "ACTIVE:$ACTIVE"
if [ "$ACTIVE" != "active" ]; then
${updateBluetoothPowerStateScript("0")}
fi
`;
      const output = await runSsh(ip, password, script);
      const active = output.includes("ACTIVE:active");
      return NextResponse.json({ success: !active, powered: false, active });
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
