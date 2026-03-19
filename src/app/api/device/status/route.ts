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
} from "@/lib/deviceStatus.js";

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
  const inactivePatched = values.INACTIVE_PATCHED === "yes";
  const inactiveHook = values.INACTIVE_HOOK === "yes";
  const inactiveDaemon = values.INACTIVE_DAEMON === "yes";
  const inactiveRestore = values.INACTIVE_RESTORE === "yes";
  const inactiveFactory = values.INACTIVE_FACTORY === "yes";
  const inactiveSwupdate = values.INACTIVE_SWUPDATE === "yes";
  const inactiveBtnxpuart = values.INACTIVE_BTNXPUART === "yes";

  if (runtimeState === "clean") {
    return !inactivePatched && !inactiveHook && !inactiveDaemon && !inactiveFactory && !inactiveSwupdate && !inactiveBtnxpuart;
  }

  if (runtimeState === "bt_only") {
    return !inactivePatched && !inactiveHook && inactiveDaemon && inactiveRestore && inactiveFactory && inactiveSwupdate && inactiveBtnxpuart;
  }

  if (runtimeState === "keypad_only") {
    return inactivePatched && inactiveHook && !inactiveDaemon && inactiveRestore && inactiveFactory && inactiveSwupdate && !inactiveBtnxpuart;
  }

  return inactivePatched && inactiveHook && inactiveDaemon && inactiveRestore && inactiveFactory && inactiveSwupdate && inactiveBtnxpuart;
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
        strings /usr/bin/xochitl 2>/dev/null | grep -q "/home/root/.kbds/" && echo "PATCHED_XOCHITL=yes" || echo "PATCHED_XOCHITL=no"
        systemctl show xochitl -p Environment 2>/dev/null | grep -q "hangul_hook" && echo "HOOK_ENV=yes" || echo "HOOK_ENV=no"
        [ -d /home/root/.kbds ] && echo "KBDS_COUNT=$(find /home/root/.kbds -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" || echo "KBDS_COUNT=0"
        BT_ENABLED=$(systemctl is-enabled hangul-daemon 2>/dev/null || echo not-found)
        BT_ACTIVE=$(systemctl is-active hangul-daemon 2>/dev/null || echo inactive)
        echo "BT_ENABLED=$BT_ENABLED"
        echo "BT_ACTIVE=$BT_ACTIVE"
        [ -f /home/root/bt-keyboard/backup/xochitl.original ] && echo "HOME_BACKUP=yes" || echo "HOME_BACKUP=no"
        [ -f /opt/bt-keyboard/xochitl.original ] && echo "OPT_BACKUP=yes" || echo "OPT_BACKUP=no"
        [ -f /etc/systemd/system/hangul-factory-guard.service ] && echo "FACTORY_GUARD=yes" || echo "FACTORY_GUARD=no"
        [ -f /etc/swupdate/conf.d/99-hangul-postupdate ] && echo "SWUPDATE_HOOK=yes" || echo "SWUPDATE_HOOK=no"
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
          strings /mnt/device_status/usr/bin/xochitl 2>/dev/null | grep -q "/home/root/.kbds/" && echo "INACTIVE_PATCHED=yes" || echo "INACTIVE_PATCHED=no"
          [ -f /mnt/device_status/usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf ] && echo "INACTIVE_HOOK=yes" || echo "INACTIVE_HOOK=no"
          [ -f /mnt/device_status/etc/systemd/system/hangul-daemon.service ] && echo "INACTIVE_DAEMON=yes" || echo "INACTIVE_DAEMON=no"
          [ -f /mnt/device_status/etc/systemd/system/hangul-restore.service ] && echo "INACTIVE_RESTORE=yes" || echo "INACTIVE_RESTORE=no"
          [ -f /mnt/device_status/etc/systemd/system/hangul-factory-guard.service ] && echo "INACTIVE_FACTORY=yes" || echo "INACTIVE_FACTORY=no"
          [ -f /mnt/device_status/etc/swupdate/conf.d/99-hangul-postupdate ] && echo "INACTIVE_SWUPDATE=yes" || echo "INACTIVE_SWUPDATE=no"
          [ -f /mnt/device_status/etc/modules-load.d/btnxpuart.conf ] && echo "INACTIVE_BTNXPUART=yes" || echo "INACTIVE_BTNXPUART=no"
        else
          echo "INACTIVE_PATCHED=no"
          echo "INACTIVE_HOOK=no"
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
    const installKeypad = values.PATCHED_XOCHITL === "yes" || values.HOOK_ENV === "yes" || Number(values.KBDS_COUNT ?? "0") > 0;
    const installBt = values.BT_ENABLED === "enabled" || values.BT_ACTIVE === "active";
    const runtimeState = deriveRuntimeState({ installKeypad, installBt });
    const hasHomeBackup = values.HOME_BACKUP === "yes";
    const hasOptBackup = values.OPT_BACKUP === "yes";
    const hasRecoveryRisk = (runtimeState === "keypad_only" || runtimeState === "both") && !hasHomeBackup && !hasOptBackup;

    const checks: CheckResult[] = [
      {
        id: "reboot-ready",
        label: "재부팅 유지",
        pass: runtimeState === "clean"
          || (!installKeypad || values.HOOK_ENV === "yes")
          && (!installBt || values.BT_ACTIVE === "active"),
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
        pass: runtimeState === "clean" || values.FACTORY_GUARD === "yes",
        detail: runtimeState === "clean"
          ? "현재는 원본 상태"
          : values.FACTORY_GUARD === "yes"
            ? "정리 가드가 설치되어 있습니다."
            : "정리 가드가 없습니다.",
      },
      {
        id: "recovery-backup",
        label: "원본 복구 백업",
        pass: runtimeState === "clean" || runtimeState === "bt_only" || hasHomeBackup || hasOptBackup,
        detail: runtimeState === "clean" || runtimeState === "bt_only"
          ? "키패드 원본 복구가 필요하지 않은 상태"
          : hasHomeBackup || hasOptBackup
            ? "원본 xochitl 백업이 존재합니다."
            : "원본 xochitl 백업이 없습니다.",
      },
      {
        id: "keypad-hook",
        label: "기존 훅 설정",
        pass: !installKeypad || values.HOOK_ENV === "yes",
        detail: !installKeypad
          ? "비활성"
          : values.HOOK_ENV === "yes"
            ? "LD_PRELOAD 적용됨"
            : "LD_PRELOAD 미적용",
      },
      {
        id: "kbds",
        label: "기존 키보드 파일",
        pass: !installKeypad || Number(values.KBDS_COUNT ?? "0") > 0,
        detail: !installKeypad
          ? "비활성"
          : `${values.KBDS_COUNT ?? "0"}개 locale`,
      },
      {
        id: "bt-daemon",
        label: "BT 데몬",
        pass: !installBt || values.BT_ACTIVE === "active",
        detail: !installBt
          ? "비활성"
          : `state=${values.BT_ACTIVE ?? "unknown"}`,
      },
      {
        id: "bt-runtime",
        label: "BT 런타임 아티팩트",
        pass: !installBt || values.BT_RUNTIME === "yes",
        detail: !installBt
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
      hasHomeBackup,
      hasOptBackup,
    });

    const recommendedAction = getRecommendedAction({
      connected: true,
      supported: detectedDevice !== null,
      runtimeState,
      hasRecoveryRisk,
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
        runtimeState,
        checks,
        hasRecoveryRisk,
      }),
      timeline: buildOperationTimeline({
        connected: true,
        runtimeState,
        checks,
      }),
      backups: {
        home: hasHomeBackup,
        opt: hasOptBackup,
      },
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
