import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { getSshSessionFromRequest } from "@/lib/server/sshSession";
import { buildBluetoothCleanupScript } from "@/lib/bluetoothPairing.js";
import {
  extractDiscoveredDevice,
  isDisplayableBluetoothDeviceName,
} from "@/lib/bluetoothScan.js";

export async function GET(request: NextRequest): Promise<Response> {
  const session = getSshSessionFromRequest(request);
  if (!session) {
    return new Response("Invalid parameters", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let scanTimeout: ReturnType<typeof setTimeout> | null = null;
      const send = (event: string, data: Record<string, unknown>): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      try {
        // Start scanning
        send("status", { message: "블루투스 스캔 시작..." });

        const env = { ...process.env, SSHPASS: session.password, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };
        const scanCmd = `# Kill all bluetooth client processes
killall bluetoothctl 2>/dev/null || true
sleep 0.5

# Load BT kernel module if not loaded
modprobe btnxpuart 2>/dev/null || true
systemctl reset-failed bluetooth.service 2>/dev/null || true
systemctl start bluetooth.service 2>/dev/null || true
sleep 1

# Check if BT adapter exists
BT_INFO=$(bluetoothctl show 2>&1)
if echo "$BT_INFO" | grep -q "No default controller"; then
  echo "BT_ERROR:블루투스 컨트롤러를 찾을 수 없습니다. 재부팅 후 다시 시도하세요."
  exit 0
fi

bluetoothctl power on 2>/dev/null
bluetoothctl pairable on 2>/dev/null
sleep 1

POWERED=$(bluetoothctl show 2>/dev/null | grep "Powered:" | awk '{print $2}')
if [ "$POWERED" != "yes" ]; then
  echo "BT_ERROR:블루투스를 활성화할 수 없습니다. 리마커블 설정에서 블루투스를 켜주세요."
  exit 0
fi

echo "BT_READY:ok"

# Try scan
SCAN_OUT=$(bluetoothctl --timeout 15 scan on 2>&1)
echo "$SCAN_OUT"

# If InProgress: kill bluetoothd to clear orphaned sessions, then retry
case "$SCAN_OUT" in
  *InProgress*)
    echo "SCAN_RETRY: bluetoothd 재시작 중..."
    killall bluetoothctl 2>/dev/null || true
    killall -9 bluetoothd 2>/dev/null || true
    sleep 3
    systemctl reset-failed bluetooth.service 2>/dev/null || true
    systemctl start bluetooth.service 2>/dev/null || true
    bluetoothctl power on 2>/dev/null || true
    sleep 1
    bluetoothctl pairable on 2>/dev/null || true
    sleep 0.5
    SCAN_OUT=$(bluetoothctl --timeout 15 scan on 2>&1)
    echo "$SCAN_OUT"
    ;;
esac

OBSERVED_ADDRS=$(printf '%s\n' "$SCAN_OUT" | awk '/Device [0-9A-F:]+/ {print $3}' | sort -u)
for OBS_ADDR in $OBSERVED_ADDRS; do
  INFO=$(bluetoothctl info "$OBS_ADDR" 2>/dev/null || true)
  NAME=$(printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*Name: //p' | head -n 1)
  if [ -z "$NAME" ]; then
    NAME=$(printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*Alias: //p' | head -n 1)
  fi
  ICON=$(printf '%s\n' "$INFO" | sed -n 's/^[[:space:]]*Icon: //p' | head -n 1)
  if [ -n "$NAME" ]; then
    echo "DEVICE|$OBS_ADDR|$NAME|$ICON"
  fi
done

${buildBluetoothCleanupScript()}
`;

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
            `root@${session.ip}`,
            scanCmd,
          ],
          { env },
        );

        const devices = new Map<string, string>();

        proc.stdout.on("data", (data: Buffer) => {
          const output = data.toString();
          const lines = output.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("BT_") && !trimmed.startsWith("DEVICE|")) {
              send("log", { line: trimmed });
            }
            if (trimmed.startsWith("BT_ERROR:")) {
              const msg = trimmed.replace("BT_ERROR:", "").trim();
              send("bt_error", { message: msg });
            } else if (trimmed.startsWith("BT_READY:")) {
              send("status", { message: "블루투스 활성화 완료, 기기 검색 중..." });
            } else if (trimmed.startsWith("DEVICE|")) {
              const parts = line.split("|");
              if (parts.length >= 3) {
                const addr = parts[1];
                const name = parts[2]?.trim() ?? "";
                const icon = parts[3]?.trim() ?? "";
                if (addr && isDisplayableBluetoothDeviceName(name) && !devices.has(addr)) {
                  devices.set(addr, name);
                  send("device", { address: addr, name, icon });
                }
              }
            } else {
              const discovered = extractDiscoveredDevice(line);
              if (discovered && !devices.has(discovered.address)) {
                devices.set(discovered.address, discovered.name);
                send("device", { address: discovered.address, name: discovered.name });
              }
            }
          }
        });

        proc.stderr.on("data", (data: Buffer) => {
          const output = data.toString();
          if (output.includes("Warning: Permanently added")) return;
          const lines = output.split("\n");
          for (const l of lines) {
            const t = l.trim();
            if (t && !t.includes("Warning:")) {
              send("log", { line: t });
            }
          }
          for (const rawLine of output.split("\n")) {
            const discovered = extractDiscoveredDevice(rawLine);
            if (discovered && !devices.has(discovered.address)) {
              devices.set(discovered.address, discovered.name);
              send("device", { address: discovered.address, name: discovered.name });
            }
          }
        });

        await new Promise<void>((resolve) => {
          proc.on("close", () => {
            if (scanTimeout) clearTimeout(scanTimeout);
            resolve();
          });
          // Safety timeout (setup ~3s + scan 15s + possible fallback 15s + queries)
          scanTimeout = setTimeout(() => {
            proc.kill();
            resolve();
          }, 45000);
        });

        send("complete", { deviceCount: devices.size });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        send("error", { message: msg });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by client disconnect
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
