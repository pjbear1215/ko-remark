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
STATE_FILE="/home/root/rekoit/install-state.conf"
if [ -f "$STATE_FILE" ]; then
  if grep -q '^BLUETOOTH_POWER_ON=' "$STATE_FILE" 2>/dev/null; then
    sed -i 's/^BLUETOOTH_POWER_ON=.*/BLUETOOTH_POWER_ON=${value}/' "$STATE_FILE" 2>/dev/null || true
  else
    printf '\nBLUETOOTH_POWER_ON=${value}\n' >> "$STATE_FILE"
  fi
fi
`;
}

function listPairedBluetoothDevicesScript(): string {
  return `
get_bluetooth_device_name() {
  ADDR="$1"
  INFO=$(bluetoothctl info "$ADDR" 2>/dev/null || true)
  NAME=$(printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*Name: //p' | head -n 1)
  if [ -n "$NAME" ]; then
    printf '%s\n' "$NAME"
    return 0
  fi
  printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*Alias: //p' | head -n 1
}

find_latest_visible_bluetooth_address_by_name() {
  TARGET_NAME="$1"
  [ -n "$TARGET_NAME" ] || return 1

  DEVICES=$(bluetoothctl devices 2>/dev/null || true)
  MATCH=$(printf '%s\n' "$DEVICES" | awk -v target="$TARGET_NAME" '
    /^Device [0-9A-F:]+ / {
      addr=$2
      name=substr($0, index($0, $3))
      if (name == target) {
        latest=addr
      }
    }
    END {
      if (latest != "") {
        print latest
      }
    }
  ')
  if [ -n "$MATCH" ]; then
    printf '%s\n' "$MATCH"
    return 0
  fi

  SCAN_OUT=$(bluetoothctl --timeout 6 scan on 2>&1 || true)
  OBSERVED_ADDRS=$(printf '%s\n' "$SCAN_OUT" | awk '/Device [0-9A-F:]+/ {print $3}' | sort -u)
  for CANDIDATE_ADDR in $OBSERVED_ADDRS; do
    [ -n "$CANDIDATE_ADDR" ] || continue
    CANDIDATE_INFO=$(bluetoothctl info "$CANDIDATE_ADDR" 2>/dev/null || true)
    CANDIDATE_NAME=$(printf '%s\n' "$CANDIDATE_INFO" | sed -n 's/^[[:space:]]*Name: //p' | head -n 1)
    CANDIDATE_ALIAS=$(printf '%s\n' "$CANDIDATE_INFO" | sed -n 's/^[[:space:]]*Alias: //p' | head -n 1)
    if [ "$CANDIDATE_NAME" = "$TARGET_NAME" ] || [ "$CANDIDATE_ALIAS" = "$TARGET_NAME" ]; then
      printf '%s\n' "$CANDIDATE_ADDR"
      return 0
    fi
  done
  return 1
}

resolve_reconnect_bluetooth_address() {
  ADDR="$1"
  [ -n "$ADDR" ] || return 1
  NAME=$(get_bluetooth_device_name "$ADDR")
  RESOLVED=$(find_latest_visible_bluetooth_address_by_name "$NAME" 2>/dev/null || true)
  if [ -n "$RESOLVED" ]; then
    printf '%s\n' "$RESOLVED"
    return 0
  fi
  printf '%s\n' "$ADDR"
}

list_paired_bluetooth_devices() {
  CANDIDATES=""
  if printf '%s\n' "\${BT_DEVICE_ADDRESS:-}" | grep -Eq '^[0-9A-F:]{17}$'; then
    CANDIDATES="$BT_DEVICE_ADDRESS"
  fi
  DEVICES=$(bluetoothctl devices Paired 2>/dev/null || true)
  TRUSTED=$(bluetoothctl devices Trusted 2>/dev/null || true)
  {
    printf '%s\n' "$CANDIDATES"
    printf '%s\n' "$DEVICES"
    printf '%s\n' "$TRUSTED"
  } | awk '/^Device [0-9A-F:]+/ {print $2} /^[0-9A-F:]{17}$/ {print $1}' | awk '!seen[$0]++'
}
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
${listPairedBluetoothDevicesScript()}
STATE_FILE="/home/root/rekoit/install-state.conf"
BT_DEVICE_ADDRESS=""
if [ -f "$STATE_FILE" ]; then
  . "$STATE_FILE"
fi
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
  for addr in $(list_paired_bluetooth_devices); do
    [ -n "$addr" ] || continue
    TARGET_ADDR=$(resolve_reconnect_bluetooth_address "$addr" 2>/dev/null || printf '%s\n' "$addr")
    bluetoothctl connect "$TARGET_ADDR" 2>/dev/null || true
    sleep 2
    if bluetoothctl info "$TARGET_ADDR" 2>/dev/null | grep -q 'Connected: yes'; then
      if [ "$TARGET_ADDR" != "$addr" ] && [ -f "$STATE_FILE" ]; then
        sed -i "s/^BT_DEVICE_ADDRESS=.*/BT_DEVICE_ADDRESS=$TARGET_ADDR/" "$STATE_FILE" 2>/dev/null || true
      fi
      break
    fi
  done
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
