import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

function runSshOnce(
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
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=30",
        `root@${ip}`,
        command,
      ],
      { env },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    proc.on("error", reject);
  });
}

async function runSsh(
  ip: string,
  password: string,
  command: string,
  retries = 3,
): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      return await runSshOnce(ip, password, command);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries - 1 && msg.includes("Permission denied")) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("SSH connection failed after retries");
}

function parseKeyValues(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

async function readKeyboardSettings(ip: string, password: string): Promise<{ swapLeftCtrlCapsLock: boolean }> {
  const output = await runSsh(
    ip,
    password,
    `
      BASEDIR="/home/root/rekoit"
      STATE_FILE="$BASEDIR/install-state.conf"
      SWAP_LEFT_CTRL_CAPSLOCK=0
      if [ -f "$STATE_FILE" ]; then
        . "$STATE_FILE"
      fi
      echo "SWAP_LEFT_CTRL_CAPSLOCK=\${SWAP_LEFT_CTRL_CAPSLOCK:-0}"
    `,
  );
  const values = parseKeyValues(output);
  return {
    swapLeftCtrlCapsLock: values.SWAP_LEFT_CTRL_CAPSLOCK === "1",
  };
}

async function updateKeyboardSettings(
  ip: string,
  password: string,
  swapLeftCtrlCapsLock: boolean,
): Promise<{ restarted: boolean }> {
  const output = await runSsh(
    ip,
    password,
    `
      BASEDIR="/home/root/rekoit"
      STATE_FILE="$BASEDIR/install-state.conf"
      mkdir -p "$BASEDIR"
      INSTALL_HANGUL=0
      INSTALL_BT=0
      SWAP_LEFT_CTRL_CAPSLOCK=0
      BT_DEVICE_ADDRESS=""
      KEYBOARD_LOCALES=""
      if [ -f "$STATE_FILE" ]; then
        . "$STATE_FILE"
      fi
      SWAP_LEFT_CTRL_CAPSLOCK=${swapLeftCtrlCapsLock ? "1" : "0"}
      printf 'INSTALL_HANGUL=%s\nINSTALL_BT=%s\nSWAP_LEFT_CTRL_CAPSLOCK=%s\nBT_DEVICE_ADDRESS=%s\nKEYBOARD_LOCALES=%s\n' "\${INSTALL_HANGUL:-0}" "\${INSTALL_BT:-0}" "$SWAP_LEFT_CTRL_CAPSLOCK" "\${BT_DEVICE_ADDRESS:-}" "\${KEYBOARD_LOCALES:-}" > "$STATE_FILE"
      HANGUL_SERVICE_LINK=$(readlink /etc/systemd/system/hangul-daemon.service 2>/dev/null || true)
      if [ -e /etc/systemd/system/hangul-daemon.service ] && [ "$HANGUL_SERVICE_LINK" != "/dev/null" ]; then
        systemctl restart hangul-daemon 2>/dev/null || true
        echo "DAEMON_RESTARTED=1"
      else
        echo "DAEMON_RESTARTED=0"
      fi
    `,
  );
  const values = parseKeyValues(output);
  return {
    restarted: values.DAEMON_RESTARTED === "1",
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const {
      ip,
      password,
      action,
      swapLeftCtrlCapsLock,
    } = body as {
      ip: string;
      password: string;
      action: "get" | "set";
      swapLeftCtrlCapsLock?: boolean;
    };

    if (!ip || !password || !action) {
      return NextResponse.json({ success: false, error: "ip, password, action 필수" }, { status: 400 });
    }

    if (!/^[\d.]+$/.test(ip)) {
      return NextResponse.json({ success: false, error: "Invalid IP" }, { status: 400 });
    }

    if (action === "get") {
      const settings = await readKeyboardSettings(ip, password);
      return NextResponse.json({ success: true, ...settings });
    }

    if (action === "set") {
      if (typeof swapLeftCtrlCapsLock !== "boolean") {
        return NextResponse.json({ success: false, error: "swapLeftCtrlCapsLock 필수" }, { status: 400 });
      }
      const result = await updateKeyboardSettings(ip, password, swapLeftCtrlCapsLock);
      return NextResponse.json({
        success: true,
        swapLeftCtrlCapsLock,
        restarted: result.restarted,
      });
    }

    return NextResponse.json({ success: false, error: "지원하지 않는 action" }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
