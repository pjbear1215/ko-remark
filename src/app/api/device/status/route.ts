import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

import { getSshSessionFromRequest } from "@/lib/server/sshSession";
import {
  buildFailureRoutines,
  buildOperationTimeline,
  deriveRuntimeState,
  getRecommendedAction,
  getRuntimeStateLabel,
  getSafetyStatus,
} from "@/lib/remarkable/deviceStatus.js";

interface CheckResult {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

function runSsh(ip: string, password: string, command: string): Promise<string> {
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
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=20",
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
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `Exit code ${code}`));
      }
    });
    proc.on("error", reject);
  });
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

function detectDevice(model: string): "paper-pro" | "paper-pro-move" | null {
  const normalized = model.toLowerCase();
  if (normalized.includes("ferrari")) return "paper-pro";
  if (normalized.includes("chiappa")) return "paper-pro-move";
  return null;
}

function matchesInactiveSlot(runtimeState: string, values: Record<string, string>): boolean {
  const inactiveDaemon = values.INACTIVE_DAEMON === "yes";
  const inactiveRestore = values.INACTIVE_RESTORE === "yes";
  const inactiveFactory = values.INACTIVE_FACTORY === "yes";
  const inactiveSwupdate = values.INACTIVE_SWUPDATE === "yes";
  const inactiveBtnxpuart = values.INACTIVE_BTNXPUART === "yes";

  if (runtimeState === "clean") {
    return !inactiveDaemon && !inactiveRestore && !inactiveFactory && !inactiveSwupdate && !inactiveBtnxpuart;
  }

  if (runtimeState === "hangul") {
    return inactiveDaemon && inactiveRestore && !inactiveFactory && inactiveSwupdate && !inactiveBtnxpuart;
  }

  if (runtimeState === "bt") {
    return !inactiveDaemon && inactiveRestore && inactiveFactory && inactiveSwupdate && inactiveBtnxpuart;
  }

  if (runtimeState === "hangul_bt") {
    return inactiveDaemon && inactiveRestore && inactiveFactory && inactiveSwupdate && inactiveBtnxpuart;
  }

  return false;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = getSshSessionFromRequest(request);

  if (!session) {
    return NextResponse.json({ error: "Missing SSH session" }, { status: 401 });
  }

  const { ip, password } = session;

  try {
    const output = await runSsh(
      ip,
      password,
      `
        set -eu
        echo "HOSTNAME=$(hostname)"
        echo "FIRMWARE=$(cat /etc/version 2>/dev/null || echo unknown)"
        echo "FREE_SPACE=$(df -h /home | tail -1 | awk '{print $4}')"
        echo "MODEL=$(cat /proc/device-tree/model 2>/dev/null | tr -d '\\000' || echo unknown)"
        HANGUL_ENABLED=$(systemctl is-enabled hangul-daemon 2>/dev/null || echo not-found)
        HANGUL_ACTIVE=$(systemctl is-active hangul-daemon 2>/dev/null || echo inactive)
        HANGUL_SERVICE_LINK=$(readlink /etc/systemd/system/hangul-daemon.service 2>/dev/null || true)
        echo "HANGUL_ENABLED=$HANGUL_ENABLED"
        echo "HANGUL_ACTIVE=$HANGUL_ACTIVE"
        if [ -e /etc/systemd/system/hangul-daemon.service ] && [ "$HANGUL_SERVICE_LINK" != "/dev/null" ]; then
          echo "HANGUL_SERVICE=yes"
        else
          echo "HANGUL_SERVICE=no"
        fi
        if [ -d /home/root/.local/share/fonts/rekoit ]; then
          echo "HANGUL_FONT=yes"
        else
          echo "HANGUL_FONT=no"
        fi
        if [ -f /home/root/rekoit/install-state.conf ]; then
          . /home/root/rekoit/install-state.conf
          echo "STATE_INSTALL_HANGUL=\${INSTALL_HANGUL:-}"
          echo "STATE_INSTALL_BT=\${INSTALL_BT:-0}"
        else
          echo "STATE_INSTALL_HANGUL="
          echo "STATE_INSTALL_BT=0"
        fi
        [ -f /etc/systemd/system/rekoit-factory-guard.service ] && echo "FACTORY_GUARD=yes" || echo "FACTORY_GUARD=no"
        [ -f /etc/swupdate/conf.d/99-rekoit-postupdate ] && echo "SWUPDATE_HOOK=yes" || echo "SWUPDATE_HOOK=no"
        [ -f /etc/modules-load.d/btnxpuart.conf ] && echo "BT_RUNTIME=yes" || echo "BT_RUNTIME=no"
        CURRENT=$(mount | awk '$3=="/" {print $1; exit}')
        case "$CURRENT" in
          /dev/mmcblk0p2) INACTIVE=/dev/mmcblk0p3 ;;
          /dev/mmcblk0p3) INACTIVE=/dev/mmcblk0p2 ;;
          *) INACTIVE="" ;;
        esac
        echo "CURRENT_ROOT=$CURRENT"
        echo "INACTIVE_ROOT=$INACTIVE"
        mkdir -p /mnt/device_status
        umount /mnt/device_status 2>/dev/null || true
        if [ -n "$INACTIVE" ]; then
          mount -o ro "$INACTIVE" /mnt/device_status 2>/dev/null || true
        fi
        if [ -n "$INACTIVE" ] && [ -d /mnt/device_status/etc ]; then
          INACTIVE_DAEMON_LINK=$(readlink /mnt/device_status/etc/systemd/system/hangul-daemon.service 2>/dev/null || true)
          if [ -e /mnt/device_status/etc/systemd/system/hangul-daemon.service ] && [ "$INACTIVE_DAEMON_LINK" != "/dev/null" ]; then
            echo "INACTIVE_DAEMON=yes"
          else
            echo "INACTIVE_DAEMON=no"
          fi
          [ -f /mnt/device_status/etc/systemd/system/rekoit-restore.service ] && echo "INACTIVE_RESTORE=yes" || echo "INACTIVE_RESTORE=no"
          [ -f /mnt/device_status/etc/systemd/system/rekoit-factory-guard.service ] && echo "INACTIVE_FACTORY=yes" || echo "INACTIVE_FACTORY=no"
          [ -f /mnt/device_status/etc/swupdate/conf.d/99-rekoit-postupdate ] && echo "INACTIVE_SWUPDATE=yes" || echo "INACTIVE_SWUPDATE=no"
          [ -f /mnt/device_status/etc/modules-load.d/btnxpuart.conf ] && echo "INACTIVE_BTNXPUART=yes" || echo "INACTIVE_BTNXPUART=no"
        else
          echo "INACTIVE_DAEMON=no"
          echo "INACTIVE_RESTORE=no"
          echo "INACTIVE_FACTORY=no"
          echo "INACTIVE_SWUPDATE=no"
          echo "INACTIVE_BTNXPUART=no"
        fi
        umount /mnt/device_status 2>/dev/null || true
      `,
    );

    const values = parseKeyValues(output);
    const detectedDevice = detectDevice(values.MODEL ?? "unknown");
    const hasHangulRuntime = values.HANGUL_SERVICE === "yes";
    const hasBtConfig = values.BT_RUNTIME === "yes";
    const hasFont = values.HANGUL_FONT === "yes";
    const runtimeState = deriveRuntimeState({ hasHangulRuntime, hasBtConfig });

    const checks: CheckResult[] = [
      {
        id: "hangul-font",
        label: "한글 폰트",
        pass: hasFont,
        detail: hasFont ? "설치됨" : "미설치",
      },
      {
        id: "reboot-ready",
        label: "재부팅 유지",
        pass: runtimeState === "clean"
          || (!hasHangulRuntime || values.HANGUL_ACTIVE === "active")
          && (!hasBtConfig || values.BT_RUNTIME === "yes"),
        detail: runtimeState === "clean"
          ? "현재는 원본 상태"
          : "활성 런타임이 현재 상태와 일치합니다.",
      },
      {
        id: "inactive-slot",
        label: "업데이트 슬롯 준비",
        pass: matchesInactiveSlot(runtimeState, values),
        detail: matchesInactiveSlot(runtimeState, values)
          ? "비활성 슬롯이 현재 상태와 일치합니다."
          : "비활성 슬롯 재준비가 필요합니다.",
      },
      {
        id: "factory-guard",
        label: "팩토리리셋 정리 경로",
        pass: runtimeState === "clean" || runtimeState === "hangul" || values.FACTORY_GUARD === "yes",
        detail: runtimeState === "clean"
          ? "현재는 원본 상태"
          : runtimeState === "hangul"
            ? "현재 구성에서는 별도 가드가 필요하지 않습니다."
          : values.FACTORY_GUARD === "yes"
            ? "정리 가드가 설치되어 있습니다."
            : "정리 가드가 없습니다.",
      },
      {
        id: "hangul-daemon",
        label: "한글 입력 데몬",
        pass: !hasHangulRuntime || values.HANGUL_ACTIVE === "active",
        detail: !hasHangulRuntime
          ? "비활성"
          : `state=${values.HANGUL_ACTIVE ?? "unknown"}`,
      },
      {
        id: "bt-config",
        label: "블루투스 설치",
        pass: !hasBtConfig || values.BT_RUNTIME === "yes",
        detail: !hasBtConfig
          ? "비활성"
          : values.BT_RUNTIME === "yes"
            ? "btnxpuart autoload 준비됨"
            : "btnxpuart autoload 없음",
      },
    ];

    const safety = getSafetyStatus({
      connected: true,
      supported: detectedDevice !== null,
      runtimeState,
    });

    const recommendedAction = getRecommendedAction({
      connected: true,
      supported: detectedDevice !== null,
      runtimeState,
    });

    return NextResponse.json({
      connected: true,
      hostname: values.HOSTNAME ?? "unknown",
      firmware: values.FIRMWARE ?? "unknown",
      freeSpace: values.FREE_SPACE ?? "unknown",
      model: values.MODEL ?? "unknown",
      detectedDevice,
      runtimeState,
      runtimeStateLabel: getRuntimeStateLabel(runtimeState),
      safety,
      recommendedAction,
      checks,
      failureRoutines: buildFailureRoutines({
        connected: true,
        checks,
      }),
      timeline: buildOperationTimeline({
        connected: true,
        runtimeState,
        checks,
      }),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        connected: false,
        error: message || "상태를 읽을 수 없습니다.",
      },
      { status: 500 },
    );
  }
}
