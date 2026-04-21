import { NextRequest } from "next/server";
import { spawn, exec } from "child_process";
import path from "path";
import fs from "fs";
import { getSshSessionFromRequest } from "@/lib/server/sshSession";
import { renderInstallState } from "@/lib/remarkable/installState.js";
import { shouldRebuildArtifact } from "@/lib/remarkable/buildArtifacts.js";

interface FileMapping {
  local: string;
  remote: string;
}

interface InstallState {
  installHangul: boolean;
  installBt: boolean;
  swapLeftCtrlCapsLock: boolean;
  btDeviceAddress: string;
  btDeviceIrk?: string;
  locales: string[];
}

type DetectedInstallState = InstallState;

const FILES_COMMON: FileMapping[] = [
  { local: "install.sh", remote: "install.sh" },
  { local: "restore.sh", remote: "restore.sh" },
  { local: "post-update.sh", remote: "post-update.sh" },
  { local: "rekoit-restore.service", remote: "rekoit-restore.service" },
];

const FILES_HANGUL: FileMapping[] = [
  { local: "install-hangul.sh", remote: "install-hangul.sh" },
  { local: "restore-hangul.sh", remote: "restore-hangul.sh" },
  { local: "post-update-hangul.sh", remote: "post-update-hangul.sh" },
  { local: "hangul-daemon/hangul-daemon", remote: "hangul-daemon" },
  { local: "hangul-daemon.service", remote: "hangul-daemon.service" },
  {
    local: "fonts/NotoSansCJKkr-Regular.otf",
    remote: "fonts/NotoSansCJKkr-Regular.otf",
  },
];

const FILES_BT: FileMapping[] = [
  { local: "install-bt.sh", remote: "install-bt.sh" },
  { local: "restore-bt.sh", remote: "restore-bt.sh" },
  { local: "post-update-bt.sh", remote: "post-update-bt.sh" },
  { local: "bt-wake-reconnect.sh", remote: "bt-wake-reconnect.sh" },
  { local: "rekoit-bt-wake-reconnect.service", remote: "rekoit-bt-wake-reconnect.service" },
  { local: "rekoit-bt-helper/rekoit-bt-helper", remote: "rekoit-bt-helper" },
];

// 폰트 다운로드 URL (Google Noto CJK - SIL OFL 라이선스)
const FONT_URLS = [
  "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf",
  "https://github.com/googlefonts/noto-cjk/raw/main/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf",
];

function runSshOnce(ip: string, password: string, command: string): Promise<string> {
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
        "-o", "PubkeyAuthentication=no",
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
          .filter((l) => !l.includes("Warning: Permanently added") && !l.includes("Connection to") && l.trim())
          .join("\n");
        reject(new Error(errorLines || `Exit code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

function isTransientSshError(message: string): boolean {
  return (
    message.includes("Exit code 255") ||
    message.includes("Connection") ||
    message.includes("kex_exchange") ||
    message.includes("broken pipe") ||
    message.includes("reset by peer")
  );
}

async function runSsh(ip: string, password: string, command: string, retries = 3): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      return await runSshOnce(ip, password, command);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries - 1 && (msg.includes("Permission denied") || isTransientSshError(msg))) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("SSH connection failed after retries");
}

function runScpOnce(
  ip: string,
  password: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SSHPASS: password, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };
    const proc = spawn(
      "sshpass",
      [
        "-e",
        "scp",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "PubkeyAuthentication=no",
        localPath,
        `root@${ip}:${remotePath}`,
      ],
      { env },
    );

    let stderr = "";
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const errorLines = stderr
          .split("\n")
          .filter((l) => !l.includes("Warning: Permanently added") && l.trim())
          .join("\n");
        reject(new Error(errorLines || `SCP failed with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

function shouldShowInstallLogLine(line: string, state: InstallState): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("STATE:")) return false;
  if (trimmed.startsWith("==========================================")) return false;
  if (trimmed.startsWith("REKOIT Installer")) return false;
  if (trimmed.startsWith("Mode:")) return false;
  if (trimmed.startsWith("Restarting services")) return false;
  if (trimmed.startsWith("Components:")) return false;
  if (trimmed.startsWith("All settings persist across reboots")) return false;
  if (trimmed.startsWith("After firmware update, run:")) return false;
  if (trimmed === "bash /home/root/rekoit/install.sh") return false;
  if (trimmed.includes("uploaded")) return false;
  if (trimmed.includes("SKIP:")) return false;
  if (!state.installHangul) {
    if (trimmed.includes("hangul-daemon")) return false;
    if (trimmed.includes("NotoSansCJKkr")) return false;
    if (trimmed.includes("libepaper")) return false;
    if (trimmed.includes("login restore")) return false;
    if (trimmed.includes("원본 파일 백업")) return false;
  }
  return true;
}

async function runScp(
  ip: string,
  password: string,
  localPath: string,
  remotePath: string,
  retries = 3,
): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      return await runScpOnce(ip, password, localPath, remotePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries - 1 && msg.includes("Permission denied")) {
        continue;
      }
      throw err;
    }
  }
}

async function detectInstalledState(
  ip: string,
  password: string,
): Promise<DetectedInstallState> {
  const output = await runSsh(
    ip,
    password,
    `
      if [ -f /home/root/rekoit/install-state.conf ]; then
        . /home/root/rekoit/install-state.conf
        echo "STATE_INSTALL_HANGUL=\${INSTALL_HANGUL:-}"
        if [ "\${INSTALL_BT:-0}" = "1" ]; then
        echo "STATE_INSTALL_BT=1"
      else
        echo "STATE_INSTALL_BT=0"
      fi
      echo "SWAP_LEFT_CTRL_CAPSLOCK=\${SWAP_LEFT_CTRL_CAPSLOCK:-0}"
      echo "BT_DEVICE_ADDRESS=\${BT_DEVICE_ADDRESS:-}"
      echo "LOCALES=\${KEYBOARD_LOCALES:-}"
      else
        echo "STATE_INSTALL_HANGUL="
        echo "STATE_INSTALL_BT="
        echo "SWAP_LEFT_CTRL_CAPSLOCK=0"
        echo "BT_DEVICE_ADDRESS="
        echo "LOCALES="
      fi
      if [ -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf ]; then
        echo "HANGUL_FONT=yes"
      else
        echo "HANGUL_FONT=no"
      fi
      HANGUL_SERVICE_LINK=$(readlink /etc/systemd/system/hangul-daemon.service 2>/dev/null || true)
      if [ -e /etc/systemd/system/hangul-daemon.service ] && [ "$HANGUL_SERVICE_LINK" != "/dev/null" ]; then
        echo "HANGUL_RUNTIME=yes"
      else
        echo "HANGUL_RUNTIME=no"
      fi
      if [ -f /etc/modules-load.d/btnxpuart.conf ]; then
        echo "BT_RUNTIME=yes"
      else
        echo "BT_RUNTIME=no"
      fi
    `,
  );

  const localesLine = output
    .split("\n")
    .find((line) => line.startsWith("LOCALES="));
  const locales = localesLine
    ? localesLine.replace("LOCALES=", "").split(",").filter(Boolean)
    : [];
  const swapLeftCtrlCapsLockLine = output
    .split("\n")
    .find((line) => line.startsWith("SWAP_LEFT_CTRL_CAPSLOCK="));
  const swapLeftCtrlCapsLock = swapLeftCtrlCapsLockLine?.replace("SWAP_LEFT_CTRL_CAPSLOCK=", "") === "1";
  const btDeviceAddressLine = output
    .split("\n")
    .find((line) => line.startsWith("BT_DEVICE_ADDRESS="));
  const btDeviceAddress = btDeviceAddressLine
    ? btDeviceAddressLine.replace("BT_DEVICE_ADDRESS=", "").trim()
    : "";
  const btDeviceIrkLine = output
    .split("\n")
    .find((line) => line.startsWith("BT_DEVICE_IRK="));
  const btDeviceIrk = btDeviceIrkLine
    ? btDeviceIrkLine.replace("BT_DEVICE_IRK=", "").trim()
    : "";
  const hasHangulRuntime = output.includes("HANGUL_RUNTIME=yes");
  const hasBtRuntime = output.includes("BT_RUNTIME=yes");

  return {
    installHangul: hasHangulRuntime,
    installBt: hasBtRuntime,
    swapLeftCtrlCapsLock,
    btDeviceAddress,
    btDeviceIrk,
    locales,
  };
}

async function verifyInstalledRuntime(
  ip: string,
  password: string,
  expectedState: InstallState,
): Promise<boolean> {
  const currentState = await detectInstalledState(ip, password);
  if (currentState.installHangul !== expectedState.installHangul) {
    return false;
  }
  if (currentState.installBt !== expectedState.installBt) {
    return false;
  }
  if (currentState.swapLeftCtrlCapsLock !== expectedState.swapLeftCtrlCapsLock) {
    return false;
  }
  if (expectedState.installHangul) {
    const daemonState = await runSsh(ip, password, "systemctl is-active hangul-daemon 2>/dev/null || true");
    if (!daemonState.includes("active")) {
      return false;
    }
  }
  if (expectedState.installBt) {
    const btRuntimeState = await runSsh(
      ip,
      password,
      "[ -f /etc/modules-load.d/btnxpuart.conf ] && echo enabled || echo missing",
    );
    if (!btRuntimeState.includes("enabled")) {
      return false;
    }
  }
  return true;
}

function runLocal(command: string, cwd?: string, timeout = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    // brew 설치 도구 경로 포함 (Apple Silicon / Intel)
    const extPath = `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/local/go/bin`;
    exec(command, { cwd, timeout, env: { ...process.env, PATH: extPath } }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function buildHangulDaemon(
  resourceDir: string,
  send: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const outputPath = path.join(resourceDir, "hangul-daemon/hangul-daemon");
  const sourceDir = path.resolve(process.cwd(), "services/hangul-daemon");
  const sourceFiles = [
    path.join(sourceDir, "main.go"),
    path.join(sourceDir, "go.mod"),
  ];

  if (!shouldRebuildArtifact(outputPath, sourceFiles)) {
    send("log", { line: "OK: hangul-daemon (이미 빌드됨)" });
    return;
  }

  if (!fs.existsSync(path.join(sourceDir, "main.go"))) {
    throw new Error(`소스 파일 없음: ${sourceDir}/main.go`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  send("log", { line: "Go 크로스 컴파일 중 (GOOS=linux GOARCH=arm64)..." });
  await runLocal(
    `GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o "${outputPath}" .`,
    sourceDir,
    180000,
  );
  send("log", { line: "OK: hangul-daemon 빌드 완료" });
}

async function buildBluetoothHelper(
  resourceDir: string,
  send: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const outputPath = path.join(resourceDir, "rekoit-bt-helper/rekoit-bt-helper");
  const sourceDir = path.resolve(process.cwd(), "services/rekoit-bt-helper");
  const sourceFiles = [
    path.join(sourceDir, "main.go"),
    path.join(sourceDir, "go.mod"),
  ];

  if (!shouldRebuildArtifact(outputPath, sourceFiles)) {
    send("log", { line: "OK: rekoit-bt-helper (이미 빌드됨)" });
    return;
  }

  if (!fs.existsSync(path.join(sourceDir, "main.go"))) {
    throw new Error(`소스 파일 없음: ${sourceDir}/main.go`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  send("log", { line: "Bluetooth Helper Go 크로스 컴파일 중 (GOOS=linux GOARCH=arm64)..." });
  await runLocal(
    `GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o "${outputPath}" .`,
    sourceDir,
    180000,
  );
  send("log", { line: "OK: rekoit-bt-helper 빌드 완료" });
}

async function downloadFont(
  resourceDir: string,
  send: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const outputPath = path.join(resourceDir, "fonts/NotoSansCJKkr-Regular.otf");

  if (fs.existsSync(outputPath)) {
    send("log", { line: "OK: NotoSansCJKkr-Regular.otf (이미 다운로드됨)" });
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  for (const url of FONT_URLS) {
    try {
      send("log", { line: "한글 폰트 다운로드 중 (Google Noto CJK)..." });
      await runLocal(
        `curl -fSL --connect-timeout 30 --max-time 300 -o "${outputPath}" "${url}"`,
        undefined,
        310000,
      );
      // 파일 크기 확인 (최소 1MB)
      const stat = fs.statSync(outputPath);
      if (stat.size < 1_000_000) {
        fs.unlinkSync(outputPath);
        throw new Error("다운로드된 파일이 너무 작습니다");
      }
      send("log", { line: `OK: 폰트 다운로드 완료 (${(stat.size / 1024 / 1024).toFixed(1)}MB)` });
      return;
    } catch {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
  }
  throw new Error("폰트 다운로드 실패. 수동으로 NotoSansCJKkr-Regular.otf를 resources/fonts/에 넣어주세요.");
}

// 롤백 스크립트: 설치 전 상태로 완전 복원
const ROLLBACK_SCRIPT = `#!/bin/sh
# hangul-rollback: 현재 설치된 한글 입력/블루투스 설치 제거
set -e

mount -o remount,rw / 2>/dev/null || true

LIBEPAPER="/usr/lib/plugins/platforms/libepaper.so"
LIBEPAPER_TMPFS="/dev/shm/hangul-libepaper.so"
ROOTFS_DEV=$(mount | grep ' / ' | head -n1 | awk '{print $1}')

echo "=== 한글 입력 롤백 시작 ==="

resolve_libepaper_mount_target() {
    if grep -q " $LIBEPAPER " /proc/mounts 2>/dev/null; then
        printf '%s\n' "$LIBEPAPER"
        return 0
    fi
    if grep -q ' /usr/lib/plugins/platforms ' /proc/mounts 2>/dev/null; then
        printf '%s\n' "/usr/lib/plugins/platforms"
        return 0
    fi
    return 1
}

unmount_libepaper_mounts() {
    while mounted_target="$(resolve_libepaper_mount_target)"; do
        umount "$mounted_target" 2>/dev/null || true
    done
}

echo "[1/7] 서비스 중지..."
systemctl stop xochitl 2>/dev/null || true
systemctl stop bluetooth.service 2>/dev/null || true
for svc in hangul-daemon.service rekoit-restore.service rekoit-factory-guard.service rekoit-bt-agent.service rekoit-bt-wake-reconnect.service; do
    systemctl stop "$svc" 2>/dev/null || true
    systemctl disable "$svc" 2>/dev/null || true
done
killall hangul-daemon 2>/dev/null || true

echo "[2/7] 활성 파티션 정리..."
rm -f /etc/systemd/system/hangul-daemon.service
rm -f /etc/systemd/system/rekoit-restore.service
rm -f /etc/systemd/system/rekoit-factory-guard.service
rm -f /etc/systemd/system/rekoit-bt-agent.service
rm -f /etc/systemd/system/rekoit-bt-wake-reconnect.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-daemon.service
rm -f /etc/systemd/system/multi-user.target.wants/rekoit-restore.service
rm -f /etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
rm -f /etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
rm -f /etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
rm -f /etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
rmdir /etc/systemd/system/bluetooth.service.d 2>/dev/null || true
rm -f /etc/swupdate/conf.d/99-rekoit-postupdate
rm -f /etc/modules-load.d/btnxpuart.conf
sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true
sed -i '/^FastConnectable = true$/d' /etc/bluetooth/main.conf 2>/dev/null || true

echo "[3/7] libepaper 원복 (마운트 해제만으로 충분)..."
unmount_libepaper_mounts || true
rm -f "$LIBEPAPER_TMPFS"

echo "[4/7] 폰트 및 rootfs 보조 파일 제거..."
rm -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf
fc-cache -f 2>/dev/null || true
rm -f /opt/rekoit/factory-guard.sh
rmdir /opt/rekoit 2>/dev/null || true

find /var/lib/bluetooth -path '*/cache' -prune -o -type f -name info -print 2>/dev/null |
while read -r INFO_FILE; do
    INFO=$(cat "$INFO_FILE" 2>/dev/null || true)
    case "$INFO" in
        *"Icon=input-keyboard"*|*"UUID=Human Interface Device"*|*"00001124-0000-1000-8000-00805f9b34fb"*)
            ADDR=$(basename "$(dirname "$INFO_FILE")")
            bluetoothctl remove "$ADDR" 2>/dev/null || true
            for ADAPTER in /var/lib/bluetooth/*; do
                [ -d "$ADAPTER" ] || continue
                rm -rf "$ADAPTER/$ADDR" "$ADAPTER/cache/$ADDR" 2>/dev/null || true
            done
            ;;
    esac
done

echo "[5/7] rootfs 영속 파일 정리..."
if [ -n "$ROOTFS_DEV" ]; then
    mkdir -p /mnt/rootfs
    mount -o rw "$ROOTFS_DEV" /mnt/rootfs 2>/dev/null || true
    if [ -d /mnt/rootfs/etc ]; then
        rm -f /mnt/rootfs/etc/systemd/system/hangul-daemon.service
        rm -f /mnt/rootfs/etc/systemd/system/rekoit-restore.service
        rm -f /mnt/rootfs/etc/systemd/system/rekoit-factory-guard.service
        rm -f /mnt/rootfs/etc/systemd/system/rekoit-bt-agent.service
        rm -f /mnt/rootfs/etc/systemd/system/rekoit-bt-wake-reconnect.service
        rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
        rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-restore.service
        rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
        rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
        rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
        rm -f /mnt/rootfs/etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
        rmdir /mnt/rootfs/etc/systemd/system/bluetooth.service.d 2>/dev/null || true
        rm -f /mnt/rootfs/etc/swupdate/conf.d/99-rekoit-postupdate
        rm -f /mnt/rootfs/etc/modules-load.d/btnxpuart.conf
        sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/rootfs/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
        sed -i '/^Privacy = off$/d' /mnt/rootfs/etc/bluetooth/main.conf 2>/dev/null || true
        sed -i '/^FastConnectable = true$/d' /mnt/rootfs/etc/bluetooth/main.conf 2>/dev/null || true
        sync
    fi
    umount /mnt/rootfs 2>/dev/null || true
fi

echo "[6/7] 비활성 파티션 정리..."
CURRENT=$(mount | grep ' / ' | head -n 1 | awk '{print $1}')
case "$CURRENT" in
    /dev/mmcblk0p2) INACTIVE=/dev/mmcblk0p3 ;;
    /dev/mmcblk0p3) INACTIVE=/dev/mmcblk0p2 ;;
    *) INACTIVE="" ;;
esac
if [ -n "$INACTIVE" ]; then
    mkdir -p /mnt/inactive
    mount -o rw "$INACTIVE" /mnt/inactive 2>/dev/null || true
    if [ -d /mnt/inactive/etc ]; then
        rm -rf /mnt/inactive/opt/rekoit
        rm -f /mnt/inactive/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf
        rm -f /mnt/inactive/etc/systemd/system/hangul-daemon.service
        rm -f /mnt/inactive/etc/systemd/system/rekoit-restore.service
        rm -f /mnt/inactive/etc/systemd/system/rekoit-factory-guard.service
        rm -f /mnt/inactive/etc/systemd/system/rekoit-bt-agent.service
        rm -f /mnt/inactive/etc/systemd/system/rekoit-bt-wake-reconnect.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-restore.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-factory-guard.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-bt-agent.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/rekoit-bt-wake-reconnect.service
        rm -f /mnt/inactive/etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
        rmdir /mnt/inactive/etc/systemd/system/bluetooth.service.d 2>/dev/null || true
        rm -f /mnt/inactive/etc/swupdate/conf.d/99-rekoit-postupdate
        rm -f /mnt/inactive/etc/modules-load.d/btnxpuart.conf
        sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/inactive/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
        sed -i '/^Privacy = off$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
        sed -i '/^FastConnectable = true$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
        sync
    fi
    umount /mnt/inactive 2>/dev/null || true
fi

echo "[7/7] 서비스 재시작..."
rm -f /home/root/.rekoit-restore-login.sh 2>/dev/null || true
if [ -f /home/root/.profile ]; then
    sed -i '\\|/home/root/.rekoit-restore-login.sh|d' /home/root/.profile 2>/dev/null || true
fi
if [ -f /home/root/.bashrc ]; then
    sed -i '/# Hangul auto-restore: 펌웨어 업데이트 후 자동 복구/,/^fi$/d' /home/root/.bashrc 2>/dev/null || true
    sed -i '/# REKOIT auto-restore: 펌웨어 업데이트 후 자동 복구/,/^fi$/d' /home/root/.bashrc 2>/dev/null || true
fi
rm -rf /home/root/rekoit 2>/dev/null || true
systemctl daemon-reload
systemctl restart xochitl 2>/dev/null || true

echo ""
echo "=== 롤백 완료 ==="
echo "현재 지원하는 설치 항목이 제거되었습니다."
echo "REKOIT 디렉토리와 블루투스 페어링 백업까지 제거되었습니다."
`;

export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl;
  const installHangul = searchParams.get("hangul") !== "false";
  const installBt = searchParams.get("bt") === "true";
  const swapLeftCtrlCapsLock = searchParams.get("swapLeftCtrlCapsLock") === "true";
  const btDeviceAddress = searchParams.get("btDeviceAddress") ?? "";
  const session = getSshSessionFromRequest(request);

  if (!session) {
    return new Response("Missing SSH session", { status: 401 });
  }

  const { ip, password } = session;

  const projectDir = path.join(process.cwd(), "resources");
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>): void => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const requestedState: InstallState = {
          installHangul,
          installBt,
          swapLeftCtrlCapsLock,
          btDeviceAddress,
          locales: [],
        };
        const currentState = await detectInstalledState(ip, password);
        const effectiveInstallHangul = currentState.installHangul || requestedState.installHangul;
        const effectiveInstallBt = currentState.installBt || requestedState.installBt;
        const effectiveState: InstallState = {
          installHangul: effectiveInstallHangul,
          installBt: effectiveInstallBt,
          swapLeftCtrlCapsLock: effectiveInstallHangul
            ? requestedState.installHangul
              ? requestedState.swapLeftCtrlCapsLock
              : currentState.swapLeftCtrlCapsLock
            : false,
          btDeviceAddress: effectiveInstallBt
            ? requestedState.btDeviceAddress || currentState.btDeviceAddress
            : "",
          btDeviceIrk: effectiveInstallBt
            ? (requestedState.btDeviceAddress && requestedState.btDeviceAddress !== currentState.btDeviceAddress)
              ? ""
              : currentState.btDeviceIrk
            : "",
          locales: [],
        };

        // === Step 0: 소스에서 바이너리 빌드 ===
        send("step", { step: 0, name: (effectiveState.installHangul || effectiveState.installBt) ? "소스에서 바이너리 빌드" : "설정 리소스 준비", status: "running" });
        send("progress", { percent: 0, step: 0 });

        if (effectiveState.installHangul) {
          await downloadFont(projectDir, send);
          send("progress", { percent: 8, step: 0 });

          await buildHangulDaemon(projectDir, send);
          send("progress", { percent: 15, step: 0 });
        }
        if (effectiveState.installBt) {
          await buildBluetoothHelper(projectDir, send);
          send("progress", { percent: 20, step: 0 });
        }

        if (effectiveState.installHangul || effectiveState.installBt) {
          send("step", { step: 0, name: "소스에서 바이너리 빌드 완료", status: "complete" });
        } else {
          send("progress", { percent: 20, step: 0 });
          send("step", { step: 0, name: "설정 리소스 준비 완료", status: "complete" });
        }

        // === Step 1: 원격 디렉토리 생성 및 백업 ===
        send("step", { step: 1, name: "원격 디렉토리 생성 및 백업", status: "running" });
        send("progress", { percent: 25, step: 1 });

        const mkdirPaths = ["/home/root/rekoit"];
        if (effectiveState.installHangul) {
          mkdirPaths.push("/home/root/rekoit/fonts", "/home/root/rekoit/backup");
        }
        await runSsh(ip, password, `mkdir -p ${mkdirPaths.join(" ")}`);
        await runSsh(
          ip,
          password,
          `cat > /home/root/rekoit/install-state.conf << 'STATE_EOF'\n${renderInstallState(effectiveState)}STATE_EOF`,
        );
        send("log", { line: "OK: install-state.conf 기록" });

        if (effectiveState.installHangul) {
          const backupCommands = `
            BACKUP_DIR="/home/root/rekoit/backup"
            LIBEPAPER_BACKUP="$BACKUP_DIR/libepaper.so.original"
            if [ -f "/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf" ] && [ ! -f "$BACKUP_DIR/font_existed" ]; then
              touch "$BACKUP_DIR/font_existed"
            fi
            # libepaper.so 원본 백업 (최초 1회)
            LIBEPAPER="/usr/lib/plugins/platforms/libepaper.so"
            if [ -f "$LIBEPAPER" ] && [ ! -f "$LIBEPAPER_BACKUP" ]; then
              cp "$LIBEPAPER" "$LIBEPAPER_BACKUP"
            fi
            echo "backup complete"
          `;
          await runSsh(ip, password, backupCommands);
          send("log", { line: "OK: 원본 파일 백업 완료 (libepaper.so 포함)" });
        }

        send("step", { step: 1, name: "원격 디렉토리 생성 및 백업", status: "complete" });

        // Step 1.5: 기존 서비스 중지
        if (effectiveState.installHangul) {
          try {
              await runSsh(
                ip,
                password,
                "systemctl stop hangul-daemon.service 2>/dev/null || true; systemctl stop rekoit-restore.service 2>/dev/null || true; rm -f /home/root/.rekoit-restore-login.sh; if [ -f /home/root/.profile ]; then sed -i '\\|/home/root/.rekoit-restore-login.sh|d' /home/root/.profile 2>/dev/null || true; fi; if [ -f /home/root/.bashrc ]; then sed -i '/# Hangul auto-restore: 펌웨어 업데이트 후 자동 복구/,/^fi$/d' /home/root/.bashrc 2>/dev/null || true; sed -i '/# REKOIT auto-restore: 펌웨어 업데이트 후 자동 복구/,/^fi$/d' /home/root/.bashrc 2>/dev/null || true; fi",
              );
              send("log", { line: "OK: 기존 서비스 중지 및 로그인 restore 정리 완료" });
            } catch {
              // 서비스 미존재 시 무시
            }
        }

        // === Step 2: 파일 업로드 ===
        const filesToUpload: FileMapping[] = [
          ...FILES_COMMON,
          ...(effectiveState.installHangul ? FILES_HANGUL : []),
          ...(effectiveState.installBt ? FILES_BT : []),
        ];

        send("log", { line: `INFO: 총 ${filesToUpload.length}개의 파일을 전송합니다 (기기 상태에 따라 시간이 걸릴 수 있습니다)...` });

        for (let i = 0; i < filesToUpload.length; i++) {
          const file = filesToUpload[i];
          const localPath = path.isAbsolute(file.local) ? file.local : path.join(projectDir, file.local);

          if (!fs.existsSync(localPath)) {
            send("log", { line: `WARNING: ${file.local} 파일을 찾을 수 없어 건너뜁니다.` });
            continue;
          }

          send("step", { step: 2, name: `파일 업로드: ${file.remote}`, status: "running" });
          
          // 대용량 폰트 파일만 이미 존재하는지 확인하여 스킵
          let skipUpload = false;
          if (file.remote.endsWith(".otf")) {
            try {
              const check = await runSshOnce(ip, password, `[ -f "/home/root/rekoit/${file.remote}" ] && echo "YES" || echo "NO"`);
              skipUpload = check.trim() === "YES";
            } catch {
              skipUpload = false;
            }
          }

          if (skipUpload) {
            send("log", { line: `OK: ${file.remote} (이미 존재함, 업로드 생략)` });
          } else {
            if (file.remote.endsWith(".otf") || file.remote.includes("daemon") || file.remote.includes("helper")) {
              send("log", { line: `업로드 중: ${file.remote}...` });
            }
            await runScp(
              ip,
              password,
              localPath,
              `/home/root/rekoit/${file.remote}`,
            );
          }
          
          send("progress", {
            percent: 30 + Math.round(((i + 1) / filesToUpload.length) * 30),
            step: 2,
          });
        }
        send("log", { line: "OK: 모든 파일 업로드 완료" });
        send("step", { step: 2, name: "파일 업로드 완료", status: "complete" });

        // === Step 3: 롤백 스크립트 업로드 ===
        send("step", { step: 3, name: "롤백 스크립트 설치", status: "running" });
        send("progress", { percent: 62, step: 3 });

        await runSsh(
          ip,
          password,
          `cat > /home/root/rekoit/rollback.sh << 'ROLLBACK_EOF'\n${ROLLBACK_SCRIPT}ROLLBACK_EOF`,
        );
        await runSsh(ip, password, "chmod +x /home/root/rekoit/rollback.sh");
        send("log", { line: "OK: rollback.sh 생성 (bash /home/root/rekoit/rollback.sh 로 롤백)" });

        send("step", { step: 3, name: "롤백 스크립트 설치 완료", status: "complete" });

        // === Step 4: install.sh 실행 ===
        send("step", { step: 4, name: "설치 스크립트 실행", status: "running" });
        send("progress", { percent: 65, step: 4 });

        try {
          const installOutput = await runSsh(
            ip,
            password,
          `INSTALL_HANGUL=${effectiveState.installHangul ? "1" : "0"} INSTALL_BT=${effectiveState.installBt ? "1" : "0"} SWAP_LEFT_CTRL_CAPSLOCK=${effectiveState.swapLeftCtrlCapsLock ? "1" : "0"} BT_DEVICE_ADDRESS=${effectiveState.btDeviceAddress} bash /home/root/rekoit/install.sh`,
          );
          const lines = installOutput.split("\n");
          for (const line of lines) {
            if (shouldShowInstallLogLine(line, effectiveState)) {
              send("log", { line });
            }
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          const transientDisconnect = msg.includes("Exit code 255") || msg.includes("Connection") || msg.includes("Permission denied");
          if (!transientDisconnect) {
            throw error;
          }

          send("log", { line: `WARNING: install.sh SSH disconnected (${msg}); verifying actual device state...` });
          await new Promise((resolve) => setTimeout(resolve, 3000));

          let installRecovered = false;
          for (let attempt = 0; attempt < 8; attempt++) {
            try {
              if (await verifyInstalledRuntime(ip, password, effectiveState)) {
                installRecovered = true;
                break;
              }
            } catch {
              // xochitl restart can bounce USB networking briefly
            }
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }

          if (!installRecovered) {
            throw error;
          }

          send("log", { line: "OK: install.sh completed; transient SSH disconnect only" });
        }

        send("step", { step: 4, name: "설치 스크립트 실행 완료", status: "complete" });
        send("progress", { percent: 80, step: 4 });

        // === Step 5: REKOIT 복구 서비스 설치 ===
        send("step", { step: 5, name: "부팅 시 REKOIT 복구 서비스 설치", status: "running" });
        send("progress", { percent: 85, step: 5 });

        const helperPaths = [
          "/home/root/rekoit/restore.sh",
          "/home/root/rekoit/post-update.sh",
          ...(effectiveState.installHangul
            ? [
                "/home/root/rekoit/restore-hangul.sh",
                "/home/root/rekoit/post-update-hangul.sh",
              ]
            : []),
          ...(effectiveState.installBt
            ? [
                "/home/root/rekoit/restore-bt.sh",
                "/home/root/rekoit/post-update-bt.sh",
                "/home/root/rekoit/bt-wake-reconnect.sh",
              ]
            : []),
        ];
        await runSsh(ip, password, `chmod +x ${helperPaths.join(" ")}`);
        send("log", { line: "OK: restore/post-update helper 활성화" });

        await runSsh(
          ip,
          password,
          "cp /home/root/rekoit/rekoit-restore.service /etc/systemd/system/rekoit-restore.service && systemctl daemon-reload && systemctl enable rekoit-restore.service 2>/dev/null || true",
        );
        send("log", { line: "OK: REKOIT 복구 서비스 생성" });
        send("log", { line: "OK: REKOIT 복구 서비스 활성화" });

        await runSsh(
          ip,
          password,
          `CURRENT_ROOT=$(mount | grep ' / ' | head -n1 | awk '{print $1}') && ROOTFS_DEV="" && case "$CURRENT_ROOT" in /dev/mmcblk0p2) ROOTFS_DEV="/dev/mmcblk0p3" ;; /dev/mmcblk0p3) ROOTFS_DEV="/dev/mmcblk0p2" ;; esac && if [ -n "$ROOTFS_DEV" ]; then mkdir -p /mnt/rootfs && umount /mnt/rootfs 2>/dev/null || true && mount -o rw "$ROOTFS_DEV" /mnt/rootfs 2>/dev/null && mkdir -p /mnt/rootfs/etc/systemd/system/multi-user.target.wants && cp /etc/systemd/system/rekoit-restore.service /mnt/rootfs/etc/systemd/system/rekoit-restore.service && ln -sf /etc/systemd/system/rekoit-restore.service /mnt/rootfs/etc/systemd/system/multi-user.target.wants/rekoit-restore.service && sync && umount /mnt/rootfs 2>/dev/null || true; fi`,
        );
        send("log", { line: "OK: REKOIT 복구 서비스 -> rootfs (reboot-safe)" });
        send("step", { step: 5, name: "부팅 시 REKOIT 복구 서비스 설치 완료", status: "complete" });

        send("progress", { percent: 100, step: 5 });
        send("complete", { success: true });
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
