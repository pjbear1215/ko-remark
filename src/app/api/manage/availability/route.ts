import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

interface AvailabilityRequest {
  ip: string;
  password: string;
}

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
      {
        env: {
          ...process.env,
          SSHPASS: password,
          PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
        },
      },
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
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `Exit code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as AvailabilityRequest;
  const { ip, password } = body;

  if (!ip || !password || !/^[\d.]+$/.test(ip)) {
    return NextResponse.json({ error: "Invalid parameters" }, { status: 400 });
  }

  try {
    const output = await runSshCheck(
      ip,
      password,
      `
      if [ -f /home/root/rekoit/install-state.conf ]; then
        . /home/root/rekoit/install-state.conf
      fi
      HANGUL_SERVICE_LINK=$(readlink /etc/systemd/system/hangul-daemon.service 2>/dev/null || true)
      if [ -e /etc/systemd/system/hangul-daemon.service ] && [ "$HANGUL_SERVICE_LINK" != "/dev/null" ]; then
        echo HANGUL_INSTALLED=1
      else
        echo HANGUL_INSTALLED=0
      fi
      if [ -f /etc/modules-load.d/btnxpuart.conf ]; then
        echo BT_INSTALLED=1
      else
        echo BT_INSTALLED=0
      fi
      if [ -e /etc/systemd/system/hangul-daemon.service ] && [ "$HANGUL_SERVICE_LINK" != "/dev/null" ] || \
         [ -f /etc/modules-load.d/btnxpuart.conf ]; then
        echo INSTALLED=1
      else
        echo INSTALLED=0
      fi
      `,
    );

    return NextResponse.json({
      installed: output.includes("INSTALLED=1"),
      hangulInstalled: output.includes("HANGUL_INSTALLED=1"),
      btInstalled: output.includes("BT_INSTALLED=1"),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { installed: false, error: message || "Unable to determine daemon state" },
      { status: 500 },
    );
  }
}
