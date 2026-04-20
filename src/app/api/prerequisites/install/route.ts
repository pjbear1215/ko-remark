import { exec } from "child_process";
import { promisify } from "util";

import {
  buildSingleToolInstallCommand,
  detectPackageManager,
  getToolStatuses,
} from "@/lib/remarkable/prerequisites";

const execAsync = promisify(exec);

export async function GET(): Promise<Response> {
  const packageManager = await detectPackageManager();
  if (!packageManager.id || !packageManager.installed) {
    return new Response("No supported package manager found", { status: 400 });
  }
  if (!packageManager.canAutoInstall) {
    return new Response("Automatic install requires interactive admin privileges", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>): void => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const extEnv = {
        ...process.env,
        PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/local/go/bin`,
      };
      const toolStatuses = await getToolStatuses();
      const missingTools = toolStatuses.filter((tool) => !tool.installed);
      const total = missingTools.length || 1;
      let completed = 0;
      let anyFailure = false;

      try {
        for (const tool of missingTools) {
          const command = buildSingleToolInstallCommand(packageManager.id!, tool.command, false);
          if (!command) {
            completed++;
            anyFailure = true;
            send("tool", {
              tool: tool.command,
              label: tool.name,
              status: "failed",
              detail: "설치 명령을 만들지 못했습니다.",
              progress: Math.round((completed / total) * 100),
            });
            continue;
          }

          send("tool", {
            tool: tool.command,
            label: tool.name,
            status: "installing",
            progress: Math.round((completed / total) * 100),
          });

          try {
            const { stdout, stderr } = await execAsync(command, {
              timeout: 300000,
              env: extEnv,
            });
            const refreshed = await getToolStatuses();
            const installed = refreshed.find((entry) => entry.command === tool.command)?.installed === true;
            completed++;
            anyFailure = anyFailure || !installed;
            send("tool", {
              tool: tool.command,
              label: tool.name,
              status: installed ? "installed" : "failed",
              detail: installed
                ? stdout.trim().split("\n").pop() ?? ""
                : stderr.trim().split("\n").pop() ?? stdout.trim().split("\n").pop() ?? "",
              progress: Math.round((completed / total) * 100),
            });
          } catch (err: unknown) {
            completed++;
            anyFailure = true;
            const msg = err instanceof Error ? err.message : String(err);
            send("tool", {
              tool: tool.command,
              label: tool.name,
              status: "failed",
              detail: msg,
              progress: Math.round((completed / total) * 100),
            });
          }
        }

        send("complete", {
          progress: 100,
          success: !anyFailure,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        send("error", { message: msg });
      } finally {
        controller.close();
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
