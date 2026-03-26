import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { getSshSessionFromRequest } from "@/lib/server/sshSession";
import {
  buildBluetoothCleanupScript,
  buildBluetoothPairSessionScript,
  classifyBluetoothJournalIssue,
  extractLatestMatchingDeviceAddress,
  extractDisplayedPasskey,
  isBluetoothReadyStatus,
  parseBluetoothInfoStatus,
  shouldTreatPairingAttemptAsSuccess,
  sanitizeBluetoothLine,
} from "@/lib/bluetoothPairing.js";

function persistBluetoothPowerState(
  session: { ip: string; password: string },
  value: "0" | "1",
): Promise<void> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      SSHPASS: session.password,
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
        "ConnectTimeout=20",
        `root@${session.ip}`,
        `
STATE_FILE="/home/root/rekoit/install-state.conf"
if [ -f "$STATE_FILE" ]; then
  if grep -q '^BLUETOOTH_POWER_ON=' "$STATE_FILE" 2>/dev/null; then
    sed -i 's/^BLUETOOTH_POWER_ON=.*/BLUETOOTH_POWER_ON=${value}/' "$STATE_FILE" 2>/dev/null || true
  else
    printf '\nBLUETOOTH_POWER_ON=${value}\n' >> "$STATE_FILE"
  fi
fi
        `,
      ],
      { env },
    );
    proc.on("close", () => resolve());
    proc.on("error", () => resolve());
  });
}

function persistBluetoothDeviceAddress(
  session: { ip: string; password: string },
  address: string,
): Promise<void> {
  if (!/^[0-9A-Fa-f:]+$/.test(address)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      SSHPASS: session.password,
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
        "ConnectTimeout=20",
        `root@${session.ip}`,
        `
STATE_FILE="/home/root/rekoit/install-state.conf"
mkdir -p /home/root/rekoit
INSTALL_HANGUL=0
INSTALL_BT=0
BLUETOOTH_POWER_ON=0
SWAP_LEFT_CTRL_CAPSLOCK=0
BT_DEVICE_ADDRESS=""
KEYBOARD_LOCALES=""
if [ -f "$STATE_FILE" ]; then
  . "$STATE_FILE"
fi
BT_DEVICE_ADDRESS=${address}
printf 'INSTALL_HANGUL=%s\nINSTALL_BT=%s\nBLUETOOTH_POWER_ON=%s\nSWAP_LEFT_CTRL_CAPSLOCK=%s\nBT_DEVICE_ADDRESS=%s\nKEYBOARD_LOCALES=%s\n' "\${INSTALL_HANGUL:-0}" "\${INSTALL_BT:-0}" "\${BLUETOOTH_POWER_ON:-0}" "\${SWAP_LEFT_CTRL_CAPSLOCK:-0}" "$BT_DEVICE_ADDRESS" "\${KEYBOARD_LOCALES:-}" > "$STATE_FILE"
        `,
      ],
      { env },
    );
    proc.on("close", () => resolve());
    proc.on("error", () => resolve());
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl;
  const address = searchParams.get("address") ?? "";
  const name = searchParams.get("name") ?? "";
  const session = getSshSessionFromRequest(request);

  if (!session || !address) {
    return new Response("Invalid parameters", { status: 400 });
  }

  if (!/^[0-9A-Fa-f:]+$/.test(address)) {
    return new Response("Invalid BT address", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
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
        send("status", { message: "페어링 준비 중..." });

        const env = { ...process.env, SSHPASS: session.password, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };

        const readInfoStatus = async (candidateAddress: string) => {
          const infoProc = spawn(
            "sshpass",
            [
              "-e",
              "ssh",
              "-o",
              "StrictHostKeyChecking=no",
              "-o",
              "UserKnownHostsFile=/dev/null",
              "-o",
              "ConnectTimeout=20",
              `root@${session.ip}`,
              `bluetoothctl info ${candidateAddress} 2>/dev/null || true`,
            ],
            { env },
          );
          let infoOutput = "";
          await new Promise<void>((resolve) => {
            infoProc.stdout.on("data", (data: Buffer) => {
              infoOutput += data.toString();
            });
            infoProc.on("close", () => resolve());
            infoProc.on("error", () => resolve());
          });
          return parseBluetoothInfoStatus(infoOutput);
        };

        let preflightStatus = await readInfoStatus(address);
        let readyAddress = isBluetoothReadyStatus(preflightStatus) ? address : "";

        if (!readyAddress && name) {
          const devicesProc = spawn(
            "sshpass",
            [
              "-e",
              "ssh",
              "-o",
              "StrictHostKeyChecking=no",
              "-o",
              "UserKnownHostsFile=/dev/null",
              "-o",
              "ConnectTimeout=20",
              `root@${session.ip}`,
              "bluetoothctl devices || true",
            ],
            { env },
          );
          let devicesOutput = "";
          await new Promise<void>((resolve) => {
            devicesProc.stdout.on("data", (data: Buffer) => {
              devicesOutput += data.toString();
            });
            devicesProc.on("close", () => resolve());
            devicesProc.on("error", () => resolve());
          });

          const latestAddress = extractLatestMatchingDeviceAddress(devicesOutput, name);
          if (latestAddress && latestAddress !== address) {
            preflightStatus = await readInfoStatus(latestAddress);
            if (isBluetoothReadyStatus(preflightStatus)) {
              readyAddress = latestAddress;
            }
          }
        }

        if (readyAddress) {
          const connectProc = spawn(
            "sshpass",
            [
              "-e",
              "ssh",
              "-o",
              "StrictHostKeyChecking=no",
              "-o",
              "UserKnownHostsFile=/dev/null",
              "-o",
              "ConnectTimeout=20",
              `root@${session.ip}`,
              `bluetoothctl connect ${readyAddress} 2>/dev/null || true`,
            ],
            { env },
          );
          await new Promise<void>((resolve) => {
            connectProc.on("close", () => resolve());
            connectProc.on("error", () => resolve());
          });

          await persistBluetoothPowerState(session, "1");
          await persistBluetoothDeviceAddress(session, readyAddress);
          send("log", { line: `ALREADY_PAIRED: ${readyAddress}` });
          send("paired", { success: true, address: readyAddress });
          send("complete", {});
          return;
        }

        const pairScript = buildBluetoothPairSessionScript({ address, name });
        const localScriptPath = path.join(os.tmpdir(), `ko-remark-pair-${Date.now()}.sh`);
        const remoteScriptPath = `/tmp/ko-remark-pair-${Date.now()}.sh`;
        await fs.writeFile(localScriptPath, pairScript, "utf8");

        await new Promise<void>((resolve, reject) => {
          const scpProc = spawn(
            "sshpass",
            [
              "-e",
              "scp",
              "-o",
              "StrictHostKeyChecking=no",
              "-o",
              "UserKnownHostsFile=/dev/null",
              localScriptPath,
              `root@${session.ip}:${remoteScriptPath}`,
            ],
            { env },
          );
          let stderr = "";
          scpProc.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });
          scpProc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || `scp exit ${code}`));
          });
          scpProc.on("error", reject);
        });

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
            `sh ${remoteScriptPath}; rm -f ${remoteScriptPath}`,
          ],
          { env },
        );

        let passkeySent = false;
        let pairResultSent = false;
        let pairStarted = false;
        let persistPowerOnAfterProcess = false;
        let resolvedAddress = address;

        const handleChunk = (data: Buffer, source: "stdout" | "stderr"): void => {
          const output = data.toString();
          const lines = output.split("\n");
          for (const line of lines) {
            const stripped = sanitizeBluetoothLine(line);
            if (!stripped) continue;

            if (
              source === "stderr" &&
              (stripped.includes("Permanently added") ||
                stripped.startsWith("Connection to "))
            ) {
              continue;
            }

            if (!pairResultSent && stripped.includes("DEVICE_NOT_FOUND")) {
              pairResultSent = true;
              send("paired", { success: false });
            }

            if (stripped.includes("INTERACTIVE_START")) {
              send("log", { line: "INTERACTIVE_START" });
            }

            if (stripped.includes("Attempting to pair")) {
              pairStarted = true;
              send("waiting_passkey", {
                message: "페어링 요청 중...",
              });
            }

            if (stripped.startsWith("PAIRED_ADDR:")) {
              const pairedAddress = stripped.replace("PAIRED_ADDR:", "").trim();
              if (pairedAddress) {
                resolvedAddress = pairedAddress;
              }
            }

            // 패스키 감지
            if (!passkeySent) {
              const displayedPasskey = extractDisplayedPasskey(stripped);
              if (displayedPasskey) {
                passkeySent = true;
                send("passkey", {
                  passkey: displayedPasskey,
                  message: `키보드에서 ${displayedPasskey} 을 입력하고 Enter를 누르세요`,
                });
              }
            }

            // 페어링 성공
            if (!pairResultSent) {
              if (
                stripped.includes("PAIR_SUCCESS") ||
                stripped.includes("Pairing successful")
              ) {
                pairResultSent = true;
                persistPowerOnAfterProcess = true;
                void persistBluetoothDeviceAddress(session, resolvedAddress);
                send("paired", { success: true, address: resolvedAddress });
              }
            }

            // 페어링 실패
            if (!pairResultSent && pairStarted) {
              if (
                stripped.includes("PAIR_PARTIAL") ||
                stripped.includes("PAIR_FAILED") ||
                (stripped.includes("Failed to pair") && !stripped.includes("InProgress")) ||
                stripped.includes("Authentication Failed") ||
                stripped.includes("Authentication Rejected") ||
                stripped.includes("AuthenticationCanceled") ||
                stripped.includes("Paired: no")
              ) {
                pairResultSent = true;
                send("paired", { success: false });
              }
            }
          }
        };

        proc.stdout.on("data", (data: Buffer) => {
          handleChunk(data, "stdout");
        });

        proc.stderr.on("data", (data: Buffer) => {
          handleChunk(data, "stderr");
        });

        let procTimeout: ReturnType<typeof setTimeout> | null = null;
        await new Promise<void>((resolve) => {
          proc.on("close", (code) => {
            send("log", { line: `PAIR_PROC_CLOSED: ${code ?? "null"}` });
            if (procTimeout) clearTimeout(procTimeout);
            resolve();
          });
          procTimeout = setTimeout(() => {
            send("log", { line: "PAIR_PROC_TIMEOUT" });
            proc.kill();
            resolve();
          }, 120000);
        });

        if (!pairResultSent) {
          const infoProc = spawn(
            "sshpass",
            [
              "-e",
              "ssh",
              "-o",
              "StrictHostKeyChecking=no",
              "-o",
              "UserKnownHostsFile=/dev/null",
              "-o",
              "ConnectTimeout=20",
              `root@${session.ip}`,
              `bluetoothctl info ${address} 2>/dev/null || true`,
            ],
            { env },
          );
          let infoOutput = "";
          await new Promise<void>((resolve) => {
            infoProc.stdout.on("data", (data: Buffer) => {
              infoOutput += data.toString();
            });
            infoProc.on("close", () => resolve());
            infoProc.on("error", () => resolve());
          });

          const infoStatus = parseBluetoothInfoStatus(infoOutput);
          let finalInfoStatus = infoStatus;

          if (!(finalInfoStatus.paired || finalInfoStatus.bonded || finalInfoStatus.trusted) && name) {
            const devicesProc = spawn(
              "sshpass",
              [
                "-e",
                "ssh",
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "UserKnownHostsFile=/dev/null",
                "-o",
                "ConnectTimeout=20",
                `root@${session.ip}`,
                "bluetoothctl devices || true",
              ],
              { env },
            );
            let devicesOutput = "";
            await new Promise<void>((resolve) => {
              devicesProc.stdout.on("data", (data: Buffer) => {
                devicesOutput += data.toString();
              });
              devicesProc.on("close", () => resolve());
              devicesProc.on("error", () => resolve());
            });

            const latestAddress = extractLatestMatchingDeviceAddress(devicesOutput, name);
            if (latestAddress && latestAddress !== address) {
              const latestInfoProc = spawn(
                "sshpass",
                [
                  "-e",
                  "ssh",
                  "-o",
                  "StrictHostKeyChecking=no",
                  "-o",
                  "UserKnownHostsFile=/dev/null",
                  "-o",
                  "ConnectTimeout=20",
                  `root@${session.ip}`,
                  `bluetoothctl info ${latestAddress} 2>/dev/null || true`,
                ],
                { env },
              );
              let latestInfoOutput = "";
              await new Promise<void>((resolve) => {
                latestInfoProc.stdout.on("data", (data: Buffer) => {
                  latestInfoOutput += data.toString();
                });
                latestInfoProc.on("close", () => resolve());
                latestInfoProc.on("error", () => resolve());
              });
              finalInfoStatus = parseBluetoothInfoStatus(latestInfoOutput);
            }
          }

          if (shouldTreatPairingAttemptAsSuccess(finalInfoStatus)) {
            if (name) {
              const devicesProc = spawn(
                "sshpass",
                [
                  "-e",
                  "ssh",
                  "-o",
                  "StrictHostKeyChecking=no",
                  "-o",
                  "UserKnownHostsFile=/dev/null",
                  "-o",
                  "ConnectTimeout=20",
                  `root@${session.ip}`,
                  "bluetoothctl devices || true",
                ],
                { env },
              );
              let devicesOutput = "";
              await new Promise<void>((resolve) => {
                devicesProc.stdout.on("data", (data: Buffer) => {
                  devicesOutput += data.toString();
                });
                devicesProc.on("close", () => resolve());
                devicesProc.on("error", () => resolve());
              });
              const latestAddress = extractLatestMatchingDeviceAddress(devicesOutput, name);
              if (latestAddress) {
                resolvedAddress = latestAddress;
              }
            }
            await persistBluetoothPowerState(session, "1");
            await persistBluetoothDeviceAddress(session, resolvedAddress);
            pairResultSent = true;
            send("paired", { success: true, address: resolvedAddress });
          } else {
            const journalProc = spawn(
              "sshpass",
              [
                "-e",
                "ssh",
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "UserKnownHostsFile=/dev/null",
                "-o",
                "ConnectTimeout=20",
                `root@${session.ip}`,
                `journalctl -u bluetooth --no-pager -n 80 | grep '${address}' || true`,
              ],
              { env },
            );
            let journalOutput = "";
            await new Promise<void>((resolve) => {
              journalProc.stdout.on("data", (data: Buffer) => {
                journalOutput += data.toString();
              });
              journalProc.on("close", () => resolve());
              journalProc.on("error", () => resolve());
            });

            const journalIssue = classifyBluetoothJournalIssue(journalOutput);
            if (journalIssue === "hog_accept_failed") {
              send("error", {
                message: "선택한 프로파일이 입력 프로파일 수락에 실패했습니다. 같은 키보드의 다른 블루투스 프로파일을 시도하세요.",
              });
            }
          }
        }

        if (persistPowerOnAfterProcess) {
          await persistBluetoothPowerState(session, "1");
          await persistBluetoothDeviceAddress(session, resolvedAddress);
        }

        send("complete", {});
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        send("error", { message: msg });
      } finally {
        closed = true;
        try {
          const tmpDir = os.tmpdir();
          const files = await fs.readdir(tmpDir);
          await Promise.all(
            files
              .filter((file) => file.startsWith("ko-remark-pair-") && file.endsWith(".sh"))
              .map((file) => fs.unlink(path.join(tmpDir, file)).catch(() => {})),
          );
        } catch {
          // ignore local temp cleanup failures
        }
        await new Promise<void>((resolve) => {
          const cleanupProc = spawn(
            "sshpass",
            [
              "-e",
              "ssh",
              "-o",
              "StrictHostKeyChecking=no",
              "-o",
              "UserKnownHostsFile=/dev/null",
              "-o",
              "ConnectTimeout=20",
              `root@${session.ip}`,
              buildBluetoothCleanupScript(),
            ],
            { env: { ...process.env, SSHPASS: session.password, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } },
          );
          cleanupProc.on("close", () => resolve());
          cleanupProc.on("error", () => resolve());
        });
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
