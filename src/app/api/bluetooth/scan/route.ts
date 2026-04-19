import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { getSshSessionFromRequest } from "@/lib/server/sshSession";
import {
  extractDiscoveredDevice,
  isDisplayableBluetoothDeviceName,
} from "@/lib/bluetoothScan.js";
import { sanitizeBluetoothLine } from "@/lib/bluetoothPairing.js";

export async function GET(request: NextRequest): Promise<Response> {
  const session = getSshSessionFromRequest(request);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const encoder = new TextEncoder();
  const sentAddresses = new Set<string>();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        try {
          if (event === "device") {
            const normalized = (data.address ?? "").toLowerCase().trim();
            if (!normalized || sentAddresses.has(normalized)) return;
            sentAddresses.add(normalized);
          }
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };

      const env = { ...process.env, SSHPASS: session.password };
      try {
        const scanCmd = `
          bluetoothctl discovery-filter --transport le 2>/dev/null || true
          
          if command -v stdbuf >/dev/null; then
            STDBUF="stdbuf -oL"
          else
            STDBUF=""
          fi
          
          echo "INFO|스캔 시작 (LE 전용, 30초)"
          $STDBUF bluetoothctl --timeout 30 scan on
          
          echo "INFO|최종 기기 목록 확인 중..."
          bluetoothctl devices 2>/dev/null | while read -r _ ADDR NAME; do
            [ -n "$ADDR" ] || continue
            echo "DEVICE|$ADDR|$NAME"
          done
        `;

        const proc = spawn("sshpass", ["-e", "ssh", "-t", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", `root@${session.ip}`, scanCmd], { env });

        proc.stdout.on("data", (data) => {
          const lines = data.toString().split("\n");
          for (const line of lines) {
            const stripped = sanitizeBluetoothLine(line);
            if (!stripped) continue;

            if (stripped.startsWith("DEVICE|")) {
              const parts = stripped.split("|");
              if (parts.length >= 3 && isDisplayableBluetoothDeviceName(parts[2])) {
                send("device", { address: parts[1].trim(), name: parts[2].trim() });
              }
            } else if (stripped.startsWith("INFO|")) {
              send("log", { line: stripped.replace("INFO|", "") });
            } else if (stripped.includes("Device")) {
              const discovered = extractDiscoveredDevice(line);
              if (discovered) send("device", discovered);
            }
          }
        });

        await new Promise<void>((res) => { proc.on("close", res); setTimeout(() => { proc.kill(); res(); }, 40000); });
        send("complete", {});
      } finally {
        spawn("sshpass", ["-e", "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", `root@${session.ip}`, "killall bluetoothctl"], { env })
          .on("close", () => { try { controller.close(); } catch {} });
      }
    }
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}
