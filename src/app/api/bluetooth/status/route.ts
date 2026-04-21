import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

function runSsh(
  ip: string,
  password: string,
  command: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SSHPASS: password,
      PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
    };
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
  const { ip, password } = body;

  if (!ip || !password) {
    return NextResponse.json({ error: "ip, password 필수" }, { status: 400 });
  }

  if (!/^[\d.]+$/.test(ip)) {
    return NextResponse.json({ error: "잘못된 IP 형식" }, { status: 400 });
  }

  try {
    const output = await runSsh(ip, password, `
ACTIVE=$(systemctl is-active bluetooth.service 2>/dev/null || true)
POWERED=no
if [ "$ACTIVE" = "active" ]; then
  POWERED=$(bluetoothctl show 2>/dev/null | grep "Powered:" | awk '{print $2}')
  [ -n "$POWERED" ] || POWERED=no
  
  # 모든 알려진 기기 목록 (Paired 또는 Trusted 상태인 기기 추출)
  # [NEW] 접두어 제거 및 정확한 컬럼 추출
  bluetoothctl devices 2>/dev/null | sed 's/\\[NEW\\] //' | while read -r TYPE ADDR NAME; do
    [ "$TYPE" = "Device" ] || continue
    INFO=$(bluetoothctl info "$ADDR" 2>/dev/null || true)
    
    # Paired 또는 Trusted 면 저장된 기기로 간주
    IS_PAIRED=$(echo "$INFO" | grep -q "Paired: yes" && echo "yes" || echo "no")
    IS_TRUSTED=$(echo "$INFO" | grep -q "Trusted: yes" && echo "yes" || echo "no")
    
    if [ "$IS_PAIRED" = "yes" ] || [ "$IS_TRUSTED" = "yes" ]; then
      IS_CONNECTED=$(echo "$INFO" | grep -q "Connected: yes" && echo "yes" || echo "no")
      # 이름이 비어있으면 info에서 다시 추출
      [ -z "$NAME" ] && NAME=$(echo "$INFO" | grep "Name:" | cut -d' ' -f2- || echo "Unknown")
      echo "DEVICE|$ADDR|$IS_CONNECTED|$NAME"
    fi
  done
fi
echo "ACTIVE:$ACTIVE"
echo "POWERED:$POWERED"
`);

    const active = output.includes("ACTIVE:active");
    const powered = output.includes("POWERED:yes");
    
    const devices: Array<{ address: string; connected: boolean; name: string }> = [];
    output.split("\n").forEach(line => {
      if (line.startsWith("DEVICE|")) {
        const parts = line.split("|");
        if (parts.length >= 4) {
          devices.push({
            address: parts[1],
            connected: parts[2] === "yes",
            name: parts.slice(3).join("|").trim()
          });
        }
      }
    });

    return NextResponse.json({
      success: true,
      active,
      powered,
      devices
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
