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
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=15",
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
      else resolve(stderr || stdout || `Exit code ${code}`);
    });
    proc.on("error", reject);

    setTimeout(() => {
      proc.kill();
      reject(new Error("timeout"));
    }, 15000);
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as { ip: string; password: string };
  const { ip, password } = body;

  if (!ip || !password || !/^[\d.]+$/.test(ip)) {
    return NextResponse.json({ error: "Invalid parameters" }, { status: 400 });
  }

  const results: Record<string, string> = {};

  try {
    results.device = await runSsh(
      ip,
      password,
      "echo MODEL=$(cat /proc/device-tree/model 2>/dev/null | tr -d '\\000' || echo unknown) && echo FIRMWARE=$(cat /etc/version 2>/dev/null || echo unknown)",
    );
  } catch {
    results.device = "SSH_ERROR";
  }

  try {
    results.input_devices = await runSsh(
      ip,
      password,
      "for dev in /dev/input/event*; do [ -e \"$dev\" ] || continue; name=$(cat \"/sys/class/input/$(basename \"$dev\")/device/name\" 2>/dev/null || echo unknown); echo \"$dev: $name\"; done",
    );
  } catch {
    results.input_devices = "SSH_ERROR";
  }

  try {
    results.libepaper_mount = await runSsh(
      ip,
      password,
      "grep ' /usr/lib/plugins/platforms/libepaper.so ' /proc/self/mountinfo 2>/dev/null || echo 'NO_LIBEPAPER_MOUNT'",
    );
  } catch {
    results.libepaper_mount = "SSH_ERROR";
  }

  try {
    results.hangul_daemon = await runSsh(
      ip,
      password,
      "echo ENABLED=$(systemctl is-enabled hangul-daemon 2>/dev/null || echo not-found) && echo ACTIVE=$(systemctl is-active hangul-daemon 2>/dev/null || echo inactive)",
    );
  } catch {
    results.hangul_daemon = "SSH_ERROR";
  }

  try {
    results.hangul_daemon_logs = await runSsh(
      ip,
      password,
      "journalctl -u hangul-daemon --no-pager -n 120 2>/dev/null || echo 'NO_LOGS'",
    );
  } catch {
    results.hangul_daemon_logs = "SSH_ERROR";
  }

  try {
    results.bluetooth = await runSsh(
      ip,
      password,
      `
echo '=== bluetooth.service ==='
echo ACTIVE=$(systemctl is-active bluetooth.service 2>/dev/null || echo unknown)
echo ENABLED=$(systemctl is-enabled bluetooth.service 2>/dev/null || echo unknown)
echo
echo '=== rekoit-bt-wake-reconnect.service ==='
echo ACTIVE=$(systemctl is-active rekoit-bt-wake-reconnect.service 2>/dev/null || echo unknown)
echo ENABLED=$(systemctl is-enabled rekoit-bt-wake-reconnect.service 2>/dev/null || echo unknown)
echo
echo '=== controller ==='
bluetoothctl show 2>/dev/null || echo 'NO_CONTROLLER'
echo
echo '=== hciconfig ==='
hciconfig hci0 2>/dev/null || echo 'NO_HCI'
echo
echo '=== main.conf flags ==='
grep -E '^(Privacy|FastConnectable)\\s*=' /etc/bluetooth/main.conf 2>/dev/null || echo 'NO_BT_FLAGS'
echo
echo '=== rekoit state ==='
if [ -f /home/root/rekoit/install-state.conf ]; then
  grep -E '^(INSTALL_BT|BLUETOOTH_POWER_ON)=' /home/root/rekoit/install-state.conf 2>/dev/null || echo 'NO_STATE_FLAGS'
else
  echo 'NO_INSTALL_STATE'
fi
echo
echo '=== paired devices ==='
PAIRED=$(bluetoothctl devices Paired 2>/dev/null || true)
if [ -z "$PAIRED" ]; then
  PAIRED=$(bluetoothctl devices 2>/dev/null || true)
fi
if [ -z "$PAIRED" ]; then
  echo 'NO_PAIRED_DEVICES'
else
  echo "$PAIRED"
  echo
  echo '=== paired device details ==='
  printf '%s\n' "$PAIRED" | while read -r _ ADDR NAME; do
    [ -n "$ADDR" ] || continue
    echo "--- $ADDR \${NAME:-} ---"
    bluetoothctl info "$ADDR" 2>/dev/null || echo 'NO_INFO'
    echo
  done
fi
echo
echo '=== bluetooth storage ==='
find /var/lib/bluetooth -maxdepth 3 \\( -name info -o -name attributes \\) -print 2>/dev/null || echo 'NO_BT_STORAGE'
      `,
    );
  } catch {
    results.bluetooth = "SSH_ERROR";
  }

  try {
    results.bluetooth_logs = await runSsh(
      ip,
      password,
      "journalctl -u bluetooth --no-pager -n 200 2>/dev/null || echo 'NO_LOGS'",
    );
  } catch {
    results.bluetooth_logs = "SSH_ERROR";
  }

  try {
    results.bluetooth_helper_logs = await runSsh(
      ip,
      password,
      "journalctl -u rekoit-bt-wake-reconnect.service --no-pager -n 120 2>/dev/null || echo 'NO_LOGS'",
    );
  } catch {
    results.bluetooth_helper_logs = "SSH_ERROR";
  }

  try {
    results.xochitl_logs = await runSsh(
      ip,
      password,
      "journalctl -u xochitl --no-pager -n 120 2>/dev/null | grep -i -E 'hangul|keyboard|input|libepaper|folio|event' || echo 'NO_MATCHES'",
    );
  } catch {
    results.xochitl_logs = "SSH_ERROR";
  }

  return NextResponse.json({ results });
}
