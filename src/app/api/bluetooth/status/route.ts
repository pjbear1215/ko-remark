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
fi
echo "ACTIVE:$ACTIVE"
echo "POWERED:$POWERED"
`);

    const active = output.includes("ACTIVE:active");
    const powered = output.includes("POWERED:yes");

    return NextResponse.json({
      success: true,
      active,
      powered,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
