import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { getSshSessionFromRequest } from "@/lib/server/sshSession";

export async function GET(request: NextRequest): Promise<Response> {
  const session = getSshSessionFromRequest(request);
  if (!session) {
    return new Response("Invalid session", { status: 401 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch (e) {
          // close might have happened
        }
      };

      const env = { ...process.env, SSHPASS: session.password };
      // Follow reconnection service logs
      const proc = spawn(
        "sshpass",
        [
          "-e",
          "ssh",
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          `root@${session.ip}`,
          "journalctl -u rekoit-bt-wake-reconnect.service -f -n 10 --no-pager -o cat",
        ],
        { env }
      );

      proc.stdout.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            send("log", { line: `[RECONNECT] ${trimmed}` });
          }
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        // Log errors but don't break the stream
        console.error("Log stream error:", data.toString());
      });

      request.signal.addEventListener("abort", () => {
        proc.kill();
      });

      proc.on("close", () => {
        try { controller.close(); } catch (e) {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
