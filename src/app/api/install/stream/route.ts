import { NextRequest } from "next/server";
import { spawn, exec } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { getSshSessionFromRequest } from "@/lib/server/sshSession";
import {
  XOCHITL_DROPIN_DIR,
  XOCHITL_HOOK_DROPIN,
  renderInstallState,
} from "@/lib/installState.js";
import { shouldRebuildArtifact } from "@/lib/buildArtifacts.js";

interface FileMapping {
  local: string;
  remote: string;
}

interface InstallState {
  installKeypad: boolean;
  installBt: boolean;
  locales: string[];
}

interface DetectedInstallState extends InstallState {
  hasHomeBackup: boolean;
  hasOptBackup: boolean;
}

const FILES_BT: FileMapping[] = [
  { local: "hangul-daemon/hangul-daemon", remote: "hangul-daemon" },
  { local: "hangul-daemon.service", remote: "hangul-daemon.service" },
];

const FILES_COMMON: FileMapping[] = [
  { local: "install.sh", remote: "install.sh" },
  {
    local: "fonts/NotoSansCJKkr-Regular.otf",
    remote: "fonts/NotoSansCJKkr-Regular.otf",
  },
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
      strings /usr/bin/xochitl 2>/dev/null | grep -q "/home/root/.kbds/" && echo "KEYPAD=yes" || echo "KEYPAD=no"
      if [ -f /home/root/bt-keyboard/hangul-daemon ] || systemctl is-enabled hangul-daemon 2>/dev/null | grep -q enabled; then
        echo "BT=yes"
      else
        echo "BT=no"
      fi
      if [ -f /home/root/bt-keyboard/install-state.conf ]; then
        . /home/root/bt-keyboard/install-state.conf
        echo "LOCALES=\${KEYBOARD_LOCALES:-}"
      elif [ -d /home/root/.kbds ]; then
        echo "LOCALES=$(find /home/root/.kbds -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; | sort | tr '\n' ',' | sed 's/,$//')"
      else
        echo "LOCALES="
      fi
      [ -f /home/root/bt-keyboard/backup/xochitl.original ] && echo "HOME_BACKUP=yes" || echo "HOME_BACKUP=no"
      [ -f /opt/bt-keyboard/xochitl.original ] && echo "OPT_BACKUP=yes" || echo "OPT_BACKUP=no"
    `,
  );

  const localesLine = output
    .split("\n")
    .find((line) => line.startsWith("LOCALES="));
  const locales = localesLine
    ? localesLine.replace("LOCALES=", "").split(",").filter(Boolean)
    : [];

  return {
    installKeypad: output.includes("KEYPAD=yes"),
    installBt: output.includes("BT=yes"),
    locales,
    hasHomeBackup: output.includes("HOME_BACKUP=yes"),
    hasOptBackup: output.includes("OPT_BACKUP=yes"),
  };
}

async function verifyInstalledRuntime(
  ip: string,
  password: string,
  expectedState: InstallState,
): Promise<boolean> {
  const currentState = await detectInstalledState(ip, password);
  if (currentState.installKeypad !== expectedState.installKeypad) {
    return false;
  }
  if (currentState.installBt !== expectedState.installBt) {
    return false;
  }
  if (expectedState.installBt) {
    const daemonState = await runSsh(ip, password, "systemctl is-active hangul-daemon 2>/dev/null || true");
    if (!daemonState.includes("active")) {
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
  const sourceDir = path.join(resourceDir, "source/hangul-daemon");
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

// restore.sh: 부팅 시 자동 복구 + 펌웨어 업데이트 대응
const RESTORE_SCRIPT = `#!/bin/sh
# hangul-restore: re-apply Korean input files after firmware update / reboot
# /home/root/bt-keyboard/ survives firmware updates; system dirs do not

set -e

# 펌웨어 업데이트 후 루트 파일시스템이 ro일 수 있음
mount -o remount,rw / 2>/dev/null || true

BASEDIR="/home/root/bt-keyboard"
STATE_FILE="$BASEDIR/install-state.conf"
HOOK_DROPIN_DIR="/mnt/updated${XOCHITL_DROPIN_DIR}"
HOOK_DROPIN="/mnt/updated${XOCHITL_HOOK_DROPIN}"

INSTALL_KEYPAD=0
INSTALL_BT=0
if [ -f "$STATE_FILE" ]; then
    . "$STATE_FILE"
fi
INSTALL_KEYPAD=0
STATE_FILE="$BASEDIR/install-state.conf"
FONT_SRC="$BASEDIR/fonts/NotoSansCJKkr-Regular.otf"
FONT_DST="/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf"
KBDS_SRC="$BASEDIR/kbds"
KBDS_DST="/home/root/.kbds"
HOOK_SRC="$BASEDIR/hangul_hook.so"
HOOK_DROPIN_DIR="${XOCHITL_DROPIN_DIR}"
HOOK_DROPIN="${XOCHITL_HOOK_DROPIN}"
SERVICE_SRC="$BASEDIR/hangul-daemon.service"
LIBEPAPER="/usr/lib/plugins/platforms/libepaper.so"
LIBEPAPER_TMPFS="/dev/shm/hangul-libepaper.so"
LIBEPAPER_BACKUP="$BASEDIR/backup/libepaper.so.original"
LEGACY_LIBEPAPER_BACKUP="$BASEDIR/libepaper.so.original"
LIBEPAPER_NEW_BACKUP="$BASEDIR/backup/libepaper.so.latest"
XOCHITL="/usr/bin/xochitl"
XOCHITL_ORIGINAL="$BASEDIR/backup/xochitl.original"
XOCHITL_PATCHED="$BASEDIR/backup/xochitl.patched"
XOCHITL_PATCHED_MD5="$BASEDIR/backup/xochitl.patched.md5"

SAFETY_BACKUP="/opt/bt-keyboard/xochitl.original"
CHANGED=0

INSTALL_KEYPAD=0
INSTALL_BT=0
if [ -f "$STATE_FILE" ]; then
    . "$STATE_FILE"
fi
INSTALL_KEYPAD=0

if [ ! -f "$LIBEPAPER_BACKUP" ] && [ -f "$LEGACY_LIBEPAPER_BACKUP" ]; then
    mkdir -p "$(dirname "$LIBEPAPER_BACKUP")"
    cp "$LEGACY_LIBEPAPER_BACKUP" "$LIBEPAPER_BACKUP"
fi

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
        if ! umount "$mounted_target" 2>/dev/null; then
            echo "[RESTORE] failed to unmount existing libepaper mount: $mounted_target" >&2
            return 1
        fi
    done
    return 0
}

ensure_tmpfs_libepaper() {
    if [ "$INSTALL_BT" != "1" ]; then
        return 0
    fi

    src=""
    if [ -f "$LIBEPAPER_BACKUP" ]; then
        src="$LIBEPAPER_BACKUP"
    elif [ -f "$LIBEPAPER" ]; then
        src="$LIBEPAPER"
    fi

    if [ -z "$src" ]; then
        return 0
    fi

    unmount_libepaper_mounts

    rm -f "$LIBEPAPER_TMPFS"
    cp "$src" "$LIBEPAPER_TMPFS"
    if [ ! -f "$LIBEPAPER_TMPFS" ]; then
        echo "[RESTORE] tmpfs source missing after copy: $LIBEPAPER_TMPFS" >&2
        return 1
    fi
    if [ ! -f "$LIBEPAPER" ]; then
        echo "[RESTORE] bind mount target missing: $LIBEPAPER" >&2
        return 1
    fi
    mount -o bind "$LIBEPAPER_TMPFS" "$LIBEPAPER"
    echo "[RESTORE] tmpfs-backed libepaper mounted"
}

XOCHITL_WAS_ACTIVE=0
if [ "$INSTALL_KEYPAD" = "1" ] && systemctl is-active --quiet xochitl 2>/dev/null; then
    XOCHITL_WAS_ACTIVE=1
    systemctl stop xochitl 2>/dev/null || true
fi

# === 팩토리 리셋 안전장치 ===
# xochitl이 패치된 상태인데 키보드 파일이 없으면 → 원본 복원
if [ "$INSTALL_KEYPAD" = "1" ] && strings "$XOCHITL" 2>/dev/null | grep -q '/home/root/.kbds/'; then
    if [ ! -d "$KBDS_SRC" ] || [ -z "$(ls -A "$KBDS_SRC" 2>/dev/null)" ]; then
        echo "[RESTORE] 팩토리 리셋 감지: 패치된 xochitl + 키보드 파일 없음"
        # 시스템 파티션 백업에서 복원 시도
        if [ -f "$SAFETY_BACKUP" ]; then
            cp "$SAFETY_BACKUP" "$XOCHITL"
            chmod 755 "$XOCHITL"
            echo "[RESTORE] xochitl 원본 복원 완료 (시스템 백업)"
            # 키보드 설정 복원 ([General] 섹션 안에 삽입)
            XOCHITL_CONF="/home/root/.config/remarkable/xochitl.conf"
            if [ -f "$XOCHITL_CONF" ]; then
                sed -i '/^Keyboard=/d' "$XOCHITL_CONF"
                if grep -q '^\\[General\\]' "$XOCHITL_CONF"; then
                    sed -i '/^\\[General\\]/a\\Keyboard=en_US' "$XOCHITL_CONF"
                else
                    echo "Keyboard=en_US" >> "$XOCHITL_CONF"
                fi
                echo "[RESTORE] 키보드 설정 -> en_US"
            fi
            systemctl daemon-reload
            systemctl restart xochitl 2>/dev/null || true
            systemctl disable hangul-restore.service 2>/dev/null || true
            rm -f "$SAFETY_BACKUP"
            exit 0
        else
            echo "[RESTORE] 경고: 원본 백업을 찾을 수 없음"
        fi
    fi
fi

# 펌웨어 업데이트 감지: xochitl 변경 확인
# 펌웨어 업데이트 시 xochitl이 원본으로 교체되므로 재패치 필요
if [ "$INSTALL_KEYPAD" = "1" ] && [ -f "$XOCHITL" ] && [ -f "$XOCHITL_PATCHED_MD5" ]; then
    CURRENT_MD5=$(md5sum "$XOCHITL" | cut -d' ' -f1)
    PATCHED_MD5=$(cat "$XOCHITL_PATCHED_MD5")
    if [ "$CURRENT_MD5" != "$PATCHED_MD5" ]; then
        echo "[RESTORE] xochitl 변경 감지 (펌웨어 업데이트)"
        # 새 원본 백업 (사용자 + 시스템 파티션 양쪽)
        cp "$XOCHITL" "$XOCHITL_ORIGINAL"
        md5sum "$XOCHITL" | cut -d' ' -f1 > "$BASEDIR/backup/xochitl.original.md5"
        mkdir -p /opt/bt-keyboard
        cp "$XOCHITL" "$SAFETY_BACKUP"
        # 패치된 백업이 있으면 사용 불가 (펌웨어 버전 불일치)
        # strings로 패턴 확인 후 재패치
        if strings "$XOCHITL" | grep -q ':/misc/keyboards/'; then
            echo "[RESTORE] xochitl 재패치 수행..."
            # dd를 사용한 온디바이스 패치
            # 패치 1: :/misc/keyboards/ -> /home/root/.kbds/
            OFFSET1=$(strings -t d "$XOCHITL" | grep ':/misc/keyboards/' | head -n1 | awk '{print \$1}')
            if [ -n "$OFFSET1" ]; then
                printf '/home/root/.kbds/' | dd of="$XOCHITL" bs=1 seek="$OFFSET1" conv=notrunc 2>/dev/null
                echo "[RESTORE] 키보드 경로 패치 완료 (offset=$OFFSET1)"
            fi
            # 패치 2: no_SV -> ko_KR, Swedish -> Korean
            OFFSET2=$(strings -t d "$XOCHITL" | grep 'no_SV' | head -n1 | awk '{print \$1}')
            if [ -n "$OFFSET2" ]; then
                printf 'ko_KR' | dd of="$XOCHITL" bs=1 seek="$OFFSET2" conv=notrunc 2>/dev/null
                # Swedish(7바이트) -> Korean\\0(7바이트) - null 포함
                SOFFSET=$(strings -t d "$XOCHITL" | grep 'Swedish' | head -n1 | awk '{print \$1}')
                if [ -n "$SOFFSET" ]; then
                    printf 'Korean\\0' | dd of="$XOCHITL" bs=1 seek="$SOFFSET" conv=notrunc 2>/dev/null
                fi
                echo "[RESTORE] 로케일 패치 완료 (offset=$OFFSET2)"
            fi
            # 새 패치 버전 백업
            cp "$XOCHITL" "$XOCHITL_PATCHED"
            md5sum "$XOCHITL" | cut -d' ' -f1 > "$XOCHITL_PATCHED_MD5"
            CHANGED=1
        fi
    fi
fi

# 펌웨어 업데이트 감지: libepaper.so 변경 확인
if [ -f "$LIBEPAPER" ] && [ -f "$LIBEPAPER_BACKUP" ]; then
    CURRENT_MD5=$(md5sum "$LIBEPAPER" | cut -d' ' -f1)
    BACKUP_MD5=$(md5sum "$LIBEPAPER_BACKUP" | cut -d' ' -f1)
    if [ "$CURRENT_MD5" != "$BACKUP_MD5" ]; then
        cp "$LIBEPAPER" "$LIBEPAPER_NEW_BACKUP"
        echo "[RESTORE] 펌웨어 업데이트 감지: libepaper.so 새 원본 백업 완료"
    fi
fi

ensure_tmpfs_libepaper

# 폰트 복구
if [ -f "$FONT_SRC" ] && [ ! -f "$FONT_DST" ]; then
    mkdir -p "$(dirname "$FONT_DST")"
    cp "$FONT_SRC" "$FONT_DST"
    CHANGED=1
fi
# 폰트 캐시 갱신 (post-update.sh가 복사한 경우에도 캐시 갱신 필요)
if [ -f "$FONT_DST" ]; then
    fc-cache -f 2>/dev/null || true
fi

# 키보드 레이아웃 복구 (동적 탐색)
if [ "$INSTALL_KEYPAD" = "1" ] && [ -d "$KBDS_SRC" ]; then
    for locale_dir in "$KBDS_SRC"/*/; do
        locale=$(basename "$locale_dir")
        if [ -f "$KBDS_SRC/$locale/keyboard_layout.json" ] && [ ! -f "$KBDS_DST/$locale/keyboard_layout.json" ]; then
            mkdir -p "$KBDS_DST/$locale"
            cp "$KBDS_SRC/$locale/keyboard_layout.json" "$KBDS_DST/$locale/keyboard_layout.json"
            CHANGED=1
        fi
    done
fi

# /opt hook 복구 + xochitl drop-in 복구
if [ "$INSTALL_KEYPAD" = "1" ] && [ -f "$HOOK_SRC" ]; then
    mkdir -p /opt/bt-keyboard
    cp "$HOOK_SRC" /opt/bt-keyboard/hangul_hook.so
    mkdir -p "$HOOK_DROPIN_DIR"
    cat > "$HOOK_DROPIN" << 'EOF'
[Service]
Environment=LD_PRELOAD=/opt/bt-keyboard/hangul_hook.so
EOF
    CHANGED=1
fi

# 키보드 설정: ko_KR 유지 ([General] 섹션 안에 삽입하여 중복 방지)
XOCHITL_CONF="/home/root/.config/remarkable/xochitl.conf"
if [ "$INSTALL_KEYPAD" = "1" ] && [ -d "$KBDS_DST" ] && [ -f "$XOCHITL_CONF" ]; then
    sed -i '/^Keyboard=/d' "$XOCHITL_CONF"
    if grep -q '^\\[General\\]' "$XOCHITL_CONF"; then
        sed -i '/^\\[General\\]/a\\Keyboard=ko_KR' "$XOCHITL_CONF"
    else
        echo "Keyboard=ko_KR" >> "$XOCHITL_CONF"
    fi
fi

# hangul-daemon 서비스 복구
if [ "$INSTALL_BT" = "1" ] && [ -f "$SERVICE_SRC" ] && [ ! -f "/etc/systemd/system/hangul-daemon.service" ]; then
    cp "$SERVICE_SRC" /etc/systemd/system/hangul-daemon.service
    systemctl daemon-reload
    systemctl enable hangul-daemon.service 2>/dev/null || true
    systemctl start hangul-daemon.service 2>/dev/null || true
    CHANGED=1
fi

# bluetooth boot-race fix: comment out ConditionPathIsDirectory
if [ "$INSTALL_BT" = "1" ]; then
    sed -i 's|^ConditionPathIsDirectory=/sys/class/bluetooth|#ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
fi

# BLE Privacy fix
if [ "$INSTALL_BT" = "1" ] && [ -f /etc/bluetooth/main.conf ] && ! grep -q '^Privacy' /etc/bluetooth/main.conf; then
    sed -i '/^\\[General\\]/a Privacy = off' /etc/bluetooth/main.conf
fi

# 변경 사항 있으면 daemon-reload만 수행
# xochitl restart는 install.sh가 아닌 route.ts에서 처리 (SSH 연결 끊김 방지)
if [ "$CHANGED" -eq 1 ]; then
    systemctl daemon-reload
    if [ "$XOCHITL_WAS_ACTIVE" -eq 1 ]; then
        systemctl start xochitl 2>/dev/null || true
    fi
fi

exit 0
`;

const RESTORE_SERVICE = `[Unit]
Description=Restore Korean (Hangul) input after firmware update
After=home.mount
Wants=home.mount
Before=xochitl.service
ConditionPathExists=/home/root/bt-keyboard/restore.sh

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh /home/root/bt-keyboard/restore.sh

[Install]
WantedBy=multi-user.target
`;

// 팩토리 리셋 안전장치: rootfs에 설치되어 /home 삭제 시에도 xochitl 원본 복원
const FACTORY_GUARD_SCRIPT = `#!/bin/sh
# hangul-factory-guard: 팩토리 리셋 후 xochitl 원본 자동 복원
# rootfs(/opt)에 설치되므로 /home 삭제 후에도 작동

XOCHITL="/usr/bin/xochitl"
KBDS="/home/root/.kbds"
ORIGINAL="/opt/bt-keyboard/xochitl.original"
HOOK_DROPIN="${XOCHITL_HOOK_DROPIN}"

# 조건: xochitl이 패치됨 + 키보드 파일 없음 = 팩토리 리셋
if ! strings "\$XOCHITL" 2>/dev/null | grep -q "/home/root/.kbds/"; then
    exit 0
fi

# /home이 마운트되었는지 확인
if ! mountpoint -q /home 2>/dev/null; then
    exit 0
fi

# 키보드 파일이 존재하면 정상 — 아무것도 안함
if [ -d "\$KBDS" ] && [ -n "\$(ls -A "\$KBDS" 2>/dev/null)" ]; then
    exit 0
fi

# === 팩토리 리셋 감지: xochitl 원본 복원 ===
mount -o remount,rw / 2>/dev/null || true

if [ -f "\$ORIGINAL" ]; then
    cp "\$ORIGINAL" "\$XOCHITL"
    chmod 755 "\$XOCHITL"
fi

# LD_PRELOAD 제거
rm -f /etc/systemd/system/xochitl.service.d/override.conf
rm -f /etc/systemd/system/xochitl.service.d/zz-hangul-hook.conf
rmdir /etc/systemd/system/xochitl.service.d 2>/dev/null || true
rm -f "\$HOOK_DROPIN"

# 키보드 설정 복원 ([General] 섹션 안에 삽입)
CONF="/home/root/.config/remarkable/xochitl.conf"
if [ -f "\$CONF" ]; then
    sed -i '/^Keyboard=ko_KR$/d' "\$CONF"
    if ! grep -q '^Keyboard=' "\$CONF"; then
        if grep -q '^\\[General\\]' "\$CONF"; then
            sed -i '/^\\[General\\]/a\\Keyboard=en_US' "\$CONF"
        else
            echo "Keyboard=en_US" >> "\$CONF"
        fi
    fi
fi

# swupdate hook 제거
rm -f /etc/swupdate/conf.d/99-hangul-postupdate

# hangul-daemon, hangul-restore 서비스 비활성화 및 제거
systemctl disable hangul-daemon.service 2>/dev/null || true
systemctl disable hangul-restore.service 2>/dev/null || true
rm -f /etc/systemd/system/hangul-daemon.service
rm -f /etc/systemd/system/hangul-restore.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-daemon.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-restore.service
rm -f /etc/modules-load.d/btnxpuart.conf
rm -f /etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
rmdir /etc/systemd/system/bluetooth.service.d 2>/dev/null || true
# Restore ConditionPathIsDirectory in bluetooth.service (handle ## or #)
sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true
# 한글 폰트 제거
rm -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf
fc-cache -f 2>/dev/null || true

# 자기 자신 정리
rm -f /opt/bt-keyboard/factory-guard.sh
rm -f /opt/bt-keyboard/xochitl.original
rm -f /opt/bt-keyboard/hangul_hook.so
rmdir /opt/bt-keyboard 2>/dev/null || true
systemctl disable hangul-factory-guard.service 2>/dev/null || true
rm -f /etc/systemd/system/hangul-factory-guard.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
systemctl daemon-reload
`;

const FACTORY_GUARD_SERVICE = `[Unit]
Description=Hangul Factory Reset Guard
After=home.mount
Wants=home.mount
Before=xochitl.service

[Service]
Type=oneshot
ExecStart=/opt/bt-keyboard/factory-guard.sh
RemainAfterExit=no

[Install]
WantedBy=multi-user.target
`;

// post-update.sh: SWUpdate -p 옵션으로 호출 — 펌웨어 업데이트 직후 (재부팅 전) 한글 파일 자동 주입
const POST_UPDATE_SCRIPT = `#!/bin/sh
# hangul-post-update: 펌웨어 업데이트 직후 (재부팅 전) 한글 파일 자동 주입
# SWUpdate -p 옵션으로 호출됨

LOG="/home/root/bt-keyboard/post-update.log"
echo "[\$(date)] post-update.sh 시작" >> "\$LOG"

BASEDIR="/home/root/bt-keyboard"

# 방금 업데이트된 파티션 감지 (= 현재 비활성 파티션)
CURRENT=\$(mount | grep " / " | head -n 1 | awk '{print \$1}')
case "\$CURRENT" in
    /dev/mmcblk0p2) UPDATED=/dev/mmcblk0p3 ;;
    /dev/mmcblk0p3) UPDATED=/dev/mmcblk0p2 ;;
    *) echo "[\$(date)] 파티션 감지 실패: \$CURRENT" >> "\$LOG"; exit 0 ;;
esac

echo "[\$(date)] 업데이트된 파티션: \$UPDATED" >> "\$LOG"

# 마운트
mkdir -p /mnt/updated
mount -o rw "\$UPDATED" /mnt/updated 2>/dev/null
if [ ! -d /mnt/updated/etc ]; then
    echo "[\$(date)] 마운트 실패" >> "\$LOG"
    exit 0
fi

# 1. xochitl 바이너리 패치 (키보드 경로 + 로케일)
XOCHITL="/mnt/updated/usr/bin/xochitl"
if [ "$INSTALL_KEYPAD" = "1" ] && [ -f "\$XOCHITL" ] && strings "\$XOCHITL" 2>/dev/null | grep -q ":/misc/keyboards/"; then
    cp "\$XOCHITL" "\$BASEDIR/backup/xochitl.original"
    md5sum "\$XOCHITL" | cut -d" " -f1 > "\$BASEDIR/backup/xochitl.original.md5"
    mkdir -p /mnt/updated/opt/bt-keyboard
    cp "\$XOCHITL" /mnt/updated/opt/bt-keyboard/xochitl.original

    OFFSET1=\$(strings -t d "\$XOCHITL" | grep ":/misc/keyboards/" | head -n 1 | awk '{print \$1}')
    if [ -n "\$OFFSET1" ]; then
        printf "/home/root/.kbds/" | dd of="\$XOCHITL" bs=1 seek="\$OFFSET1" conv=notrunc 2>/dev/null
        echo "[\$(date)] OK: xochitl 키보드 경로 패치 (offset=\$OFFSET1)" >> "\$LOG"
    fi

    OFFSET2=\$(strings -t d "\$XOCHITL" | grep "no_SV" | head -n 1 | awk '{print \$1}')
    if [ -n "\$OFFSET2" ]; then
        printf "ko_KR" | dd of="\$XOCHITL" bs=1 seek="\$OFFSET2" conv=notrunc 2>/dev/null
        SOFFSET=\$(strings -t d "\$XOCHITL" | grep "Swedish" | head -n 1 | awk '{print \$1}')
        if [ -n "\$SOFFSET" ]; then
            printf "Korean\\0" | dd of="\$XOCHITL" bs=1 seek="\$SOFFSET" conv=notrunc 2>/dev/null
        fi
        echo "[\$(date)] OK: xochitl 로케일 패치 (ko_KR/Korean)" >> "\$LOG"
    fi

    cp "\$XOCHITL" "\$BASEDIR/backup/xochitl.patched"
    md5sum "\$XOCHITL" | cut -d" " -f1 > "\$BASEDIR/backup/xochitl.patched.md5"
else
    echo "[\$(date)] SKIP: xochitl 이미 패치됨 또는 없음" >> "\$LOG"
fi

# 2. 한글 폰트 복사
FONT_SRC="\$BASEDIR/fonts/NotoSansCJKkr-Regular.otf"
FONT_DST="/mnt/updated/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf"
if [ -f "\$FONT_SRC" ]; then
    mkdir -p "\$(dirname "\$FONT_DST")"
    cp "\$FONT_SRC" "\$FONT_DST"
    echo "[\$(date)] OK: 한글 폰트" >> "\$LOG"
fi

# 3. hangul_hook.so
if [ "$INSTALL_KEYPAD" = "1" ] && [ -f "\$BASEDIR/hangul_hook.so" ]; then
    mkdir -p /mnt/updated/opt/bt-keyboard
    cp "\$BASEDIR/hangul_hook.so" /mnt/updated/opt/bt-keyboard/hangul_hook.so
    echo "[\$(date)] OK: hangul_hook.so" >> "\$LOG"
fi

# 4. xochitl 서비스 오버라이드 (LD_PRELOAD)
if [ "$INSTALL_KEYPAD" = "1" ]; then
mkdir -p "$HOOK_DROPIN_DIR"
cat > "$HOOK_DROPIN" << 'ZZHOOK_EOF'
[Service]
Environment=LD_PRELOAD=/opt/bt-keyboard/hangul_hook.so
ZZHOOK_EOF
echo "[\$(date)] OK: LD_PRELOAD 설정" >> "\$LOG"
fi

# 5. btnxpuart 블루투스 모듈
if [ "$INSTALL_BT" = "1" ]; then
    mkdir -p /mnt/updated/etc/modules-load.d
    echo "btnxpuart" > /mnt/updated/etc/modules-load.d/btnxpuart.conf
    echo "[\$(date)] OK: btnxpuart.conf" >> "\$LOG"
fi

# 6. hangul-daemon.service
if [ "$INSTALL_BT" = "1" ] && [ -f "\$BASEDIR/hangul-daemon.service" ]; then
    cp "\$BASEDIR/hangul-daemon.service" /mnt/updated/etc/systemd/system/hangul-daemon.service
    mkdir -p /mnt/updated/etc/systemd/system/multi-user.target.wants
    ln -sf /etc/systemd/system/hangul-daemon.service /mnt/updated/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
    echo "[\$(date)] OK: hangul-daemon.service" >> "\$LOG"
fi

# 6b. bluetooth boot-race fix for updated partition
if [ "$INSTALL_BT" = "1" ]; then
    sed -i 's|^ConditionPathIsDirectory=/sys/class/bluetooth|#ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/updated/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
    echo "[\$(date)] OK: bluetooth boot-race fix" >> "\$LOG"
fi

# 6c. BLE Privacy fix for updated partition
if [ "$INSTALL_BT" = "1" ] && [ -f /mnt/updated/etc/bluetooth/main.conf ] && ! grep -q '^Privacy' /mnt/updated/etc/bluetooth/main.conf; then
    sed -i '/^\\[General\\]/a Privacy = off' /mnt/updated/etc/bluetooth/main.conf
    echo "[\$(date)] OK: BLE privacy disabled" >> "\$LOG"
fi

# 7. hangul-restore.service (부팅 시 안전망)
cat > /mnt/updated/etc/systemd/system/hangul-restore.service << 'RESTORE_SVC_EOF'
[Unit]
Description=Hangul Input Restore
After=home.mount
Wants=home.mount
ConditionPathExists=/home/root/bt-keyboard/restore.sh

[Service]
Type=oneshot
ExecStart=/home/root/bt-keyboard/restore.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
RESTORE_SVC_EOF
mkdir -p /mnt/updated/etc/systemd/system/multi-user.target.wants
ln -sf /etc/systemd/system/hangul-restore.service /mnt/updated/etc/systemd/system/multi-user.target.wants/hangul-restore.service
echo "[\$(date)] OK: hangul-restore.service" >> "\$LOG"

# 8. swupdate conf.d 자기 복제
mkdir -p /mnt/updated/etc/swupdate/conf.d
cat > /mnt/updated/etc/swupdate/conf.d/99-hangul-postupdate << 'CONFD_EOF'
# Hangul post-update hook (auto-replicated)
SWUPDATE_ARGS+=" -p /home/root/bt-keyboard/post-update.sh"
CONFD_EOF
echo "[\$(date)] OK: conf.d 자기 복제" >> "\$LOG"

# 9. factory-guard 복제 (팩토리 리셋 안전장치)
if [ "$INSTALL_KEYPAD" = "1" ] && [ -f /opt/bt-keyboard/factory-guard.sh ]; then
    mkdir -p /mnt/updated/opt/bt-keyboard
    cp /opt/bt-keyboard/factory-guard.sh /mnt/updated/opt/bt-keyboard/factory-guard.sh
    chmod +x /mnt/updated/opt/bt-keyboard/factory-guard.sh
    cat > /mnt/updated/etc/systemd/system/hangul-factory-guard.service << 'FGUARD_EOF'
[Unit]
Description=Hangul Factory Reset Guard
After=home.mount
Wants=home.mount
Before=xochitl.service

[Service]
Type=oneshot
ExecStart=/opt/bt-keyboard/factory-guard.sh
RemainAfterExit=no

[Install]
WantedBy=multi-user.target
FGUARD_EOF
    ln -sf /etc/systemd/system/hangul-factory-guard.service /mnt/updated/etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
    echo "[\$(date)] OK: factory-guard 복제" >> "\$LOG"
fi

sync
umount /mnt/updated 2>/dev/null || true

echo "[\$(date)] post-update.sh 완료 (9/9 항목)" >> "\$LOG"
`;

// swupdate conf.d 설정 (post-update hook 등록)
const SWUPDATE_CONFD = `# Hangul post-update hook
SWUPDATE_ARGS+=" -p /home/root/bt-keyboard/post-update.sh"
`;

// 롤백 스크립트: 설치 전 상태로 완전 복원
const ROLLBACK_SCRIPT = `#!/bin/sh
# hangul-rollback: 한글 입력 설정을 완전히 제거하고 원본 복원
set -e

mount -o remount,rw / 2>/dev/null || true

BASEDIR="/home/root/bt-keyboard"
BACKUP_DIR="$BASEDIR/backup"
LIBEPAPER="/usr/lib/plugins/platforms/libepaper.so"
LIBEPAPER_TMPFS="/dev/shm/hangul-libepaper.so"

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
        if ! umount "$mounted_target" 2>/dev/null; then
            echo "  WARN: 기존 libepaper mount 해제 실패: $mounted_target"
            return 1
        fi
    done
    return 0
}

# 1. 서비스 중지
echo "[1/10] 서비스 중지..."
systemctl stop xochitl 2>/dev/null || true
systemctl stop hangul-daemon.service 2>/dev/null || true
systemctl disable hangul-daemon.service 2>/dev/null || true
systemctl stop hangul-restore.service 2>/dev/null || true
systemctl disable hangul-restore.service 2>/dev/null || true
killall hangul-daemon 2>/dev/null || true

# 2. xochitl 원본 복원 (현재 파티션)
echo "[2/10] xochitl 원본 복원..."
if [ -f "$BACKUP_DIR/xochitl.original" ]; then
    cp "$BACKUP_DIR/xochitl.original" /usr/bin/xochitl
    chmod 755 /usr/bin/xochitl
    echo "  OK: xochitl 원본 복원됨"
else
    echo "  SKIP: xochitl.original 백업 없음"
fi

# 3. LD_PRELOAD 오버라이드 제거
echo "[3/10] LD_PRELOAD 오버라이드 제거..."
rm -f /etc/systemd/system/xochitl.service.d/override.conf
rm -f /etc/systemd/system/xochitl.service.d/zz-hangul-hook.conf
rm -f /usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf
ROOTFS_DEV=$(mount | grep ' / ' | head -n1 | awk '{print $1}')
if [ -n "$ROOTFS_DEV" ]; then
    mkdir -p /mnt/rootfs
    mount -o rw "$ROOTFS_DEV" /mnt/rootfs 2>/dev/null || true
    rm -f /mnt/rootfs/usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf
    rm -f /mnt/rootfs/etc/systemd/system/xochitl.service.d/zz-hangul-hook.conf
    rm -f /mnt/rootfs/etc/systemd/system/xochitl.service.d/override.conf
    rm -f /mnt/rootfs/etc/swupdate/conf.d/99-hangul-postupdate
    rm -f /mnt/rootfs/etc/modules-load.d/btnxpuart.conf
    sync
    umount /mnt/rootfs 2>/dev/null || true
fi
rmdir /etc/systemd/system/xochitl.service.d 2>/dev/null || true

# 4. 서비스 파일 제거 (overlay + rootfs 양쪽)
echo "[4/10] 서비스 파일 제거..."
rm -f /etc/systemd/system/hangul-daemon.service
rm -f /etc/systemd/system/hangul-restore.service
rm -f /etc/systemd/system/hangul-factory-guard.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-daemon.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-restore.service
rm -f /etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
rm -f /etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
rmdir /etc/systemd/system/bluetooth.service.d 2>/dev/null || true
sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true
if [ -n "$ROOTFS_DEV" ]; then
    mkdir -p /mnt/rootfs
    mount -o rw "$ROOTFS_DEV" /mnt/rootfs 2>/dev/null || true
    rm -f /mnt/rootfs/etc/systemd/system/hangul-daemon.service
    rm -f /mnt/rootfs/etc/systemd/system/hangul-restore.service
    rm -f /mnt/rootfs/etc/systemd/system/hangul-factory-guard.service
    rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
    rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/hangul-restore.service
    rm -f /mnt/rootfs/etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
    rm -f /mnt/rootfs/etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
    rmdir /mnt/rootfs/etc/systemd/system/bluetooth.service.d 2>/dev/null || true
    sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/rootfs/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
    sed -i '/^Privacy = off$/d' /mnt/rootfs/etc/bluetooth/main.conf 2>/dev/null || true
    rmdir /mnt/rootfs/etc/systemd/system/xochitl.service.d 2>/dev/null || true
    sync
    umount /mnt/rootfs 2>/dev/null || true
fi

# 5. swupdate conf.d + post-update 제거
echo "[5/10] SWUpdate hook 제거..."
rm -f /etc/swupdate/conf.d/99-hangul-postupdate
systemctl restart swupdate 2>/dev/null || true

# 6. libepaper.so 원본 복원
echo "[6/10] libepaper.so 원본 복원..."
unmount_libepaper_mounts || true
rm -f "$LIBEPAPER_TMPFS"
if [ -f "/home/root/bt-keyboard/backup/libepaper.so.original" ]; then
    cp "/home/root/bt-keyboard/backup/libepaper.so.original" /usr/lib/plugins/platforms/libepaper.so
    echo "  OK: 원본 복원됨"
fi

# 7. 설치된 파일 제거
echo "[7/10] 설치된 파일 제거..."
rm -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf
rm -rf /home/root/.kbds
rm -f /opt/bt-keyboard/factory-guard.sh
rm -f /opt/bt-keyboard/xochitl.original
rm -f /opt/bt-keyboard/hangul_hook.so
rmdir /opt/bt-keyboard 2>/dev/null || true

# 8. 키보드 설정 복원 + .bashrc 정리
echo "[8/10] 키보드 설정 복원..."
rm -f /home/root/.bashrc
XOCHITL_CONF="/home/root/.config/remarkable/xochitl.conf"
if [ -f "$XOCHITL_CONF" ]; then
    sed -i '/^Keyboard=ko_KR$/d' "$XOCHITL_CONF"
    if ! grep -q '^Keyboard=' "$XOCHITL_CONF"; then
        if grep -q '^\[General\]' "$XOCHITL_CONF"; then
            sed -i '/^\[General\]/a\Keyboard=en_US' "$XOCHITL_CONF"
        else
            echo "Keyboard=en_US" >> "$XOCHITL_CONF"
        fi
    fi
    echo "  OK: ko_KR -> en_US"
fi

# 9. 비활성 파티션 정리
echo "[9/10] 비활성 파티션 정리..."
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
        # xochitl 원본 복원
        if [ -f /mnt/inactive/opt/bt-keyboard/xochitl.original ]; then
            cp /mnt/inactive/opt/bt-keyboard/xochitl.original /mnt/inactive/usr/bin/xochitl
            chmod 755 /mnt/inactive/usr/bin/xochitl
            echo "  OK: 비활성 파티션 xochitl 원본 복원"
        fi
        rm -rf /mnt/inactive/opt/bt-keyboard
        rm -f /mnt/inactive/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf
        rm -f /mnt/inactive/etc/swupdate/conf.d/99-hangul-postupdate
        rm -f /mnt/inactive/usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf
        rm -f /mnt/inactive/etc/systemd/system/xochitl.service.d/override.conf
        rm -f /mnt/inactive/etc/systemd/system/xochitl.service.d/zz-hangul-hook.conf
        rmdir /mnt/inactive/etc/systemd/system/xochitl.service.d 2>/dev/null || true
        rm -f /mnt/inactive/etc/systemd/system/hangul-daemon.service
        rm -f /mnt/inactive/etc/systemd/system/hangul-restore.service
        rm -f /mnt/inactive/etc/systemd/system/hangul-factory-guard.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-restore.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
        rm -f /mnt/inactive/etc/modules-load.d/btnxpuart.conf
        rm -f /mnt/inactive/etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
        rmdir /mnt/inactive/etc/systemd/system/bluetooth.service.d 2>/dev/null || true
        sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/inactive/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
        sed -i '/^Privacy = off$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
        sync
        echo "  OK: 비활성 파티션 한글 흔적 제거"
    fi
    umount /mnt/inactive 2>/dev/null || true
fi

# 10. 서비스 재시작
echo "[10/10] 서비스 재시작..."
systemctl daemon-reload
systemctl restart xochitl 2>/dev/null || true

echo ""
echo "=== 롤백 완료 ==="
echo "양쪽 파티션 모두 원본 상태로 복원되었습니다."
echo "bt-keyboard 디렉토리는 보존됩니다 (재설치 시 사용)."
echo "완전 삭제하려면: rm -rf /home/root/bt-keyboard"
`;

export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl;
  const installKeypad = searchParams.get("keypad") === "true";
  const installBt = searchParams.get("bt") !== "false";
  const session = getSshSessionFromRequest(request);

  if (!session) {
    return new Response("Missing SSH session", { status: 401 });
  }

  const { ip, password } = session;

  if (installKeypad) {
    return new Response("현재는 Type Folio/BT 입력만 설치할 수 있습니다.", { status: 400 });
  }

  if (!installBt) {
    return new Response("현재는 Type Folio/BT 입력 설치만 지원합니다.", { status: 400 });
  }

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
          installKeypad: false,
          installBt,
          locales: [],
        };
        const currentState = await detectInstalledState(ip, password);
        const effectiveState: InstallState = {
          installKeypad: false,
          installBt: true,
          locales: [],
        };

        send("log", {
          line: `STATE: current keypad=${currentState.installKeypad ? 1 : 0}, bt=${currentState.installBt ? 1 : 0}, locales=${currentState.locales.join(",") || "-"}, homeBackup=${currentState.hasHomeBackup ? 1 : 0}, optBackup=${currentState.hasOptBackup ? 1 : 0}; requested keypad=${requestedState.installKeypad ? 1 : 0}, bt=${requestedState.installBt ? 1 : 0}, locales=${requestedState.locales.join(",") || "-"}; effective keypad=${effectiveState.installKeypad ? 1 : 0}, bt=${effectiveState.installBt ? 1 : 0}, locales=${effectiveState.locales.join(",") || "-"}`,
        });

        if (currentState.installKeypad) {
          throw new Error("기존 설치 상태가 감지되었습니다. 전체 원상복구 후 다시 설치해주세요.");
        }

        // === Step 0: 소스에서 바이너리 빌드 ===
        send("step", { step: 0, name: "소스에서 바이너리 빌드", status: "running" });
        send("progress", { percent: 0, step: 0 });

        await downloadFont(projectDir, send);
        send("progress", { percent: 8, step: 0 });

        if (effectiveState.installBt) {
          await buildHangulDaemon(projectDir, send);
          send("progress", { percent: 20, step: 0 });
        }

        send("step", { step: 0, name: "소스에서 바이너리 빌드 완료", status: "complete" });

        // === Step 1: 원격 디렉토리 생성 및 백업 ===
        send("step", { step: 1, name: "원격 디렉토리 생성 및 백업", status: "running" });
        send("progress", { percent: 25, step: 1 });

        const mkdirPaths = [
          "/home/root/bt-keyboard/fonts",
          "/home/root/bt-keyboard/backup",
        ];
        await runSsh(ip, password, `mkdir -p ${mkdirPaths.join(" ")}`);
        await runSsh(
          ip,
          password,
          `cat > /home/root/bt-keyboard/install-state.conf << 'STATE_EOF'\n${renderInstallState(effectiveState)}STATE_EOF`,
        );
        send("log", { line: "OK: install-state.conf 기록" });

        const backupCommands = `
          BACKUP_DIR="/home/root/bt-keyboard/backup"
          LIBEPAPER_BACKUP="$BACKUP_DIR/libepaper.so.original"
          LEGACY_LIBEPAPER_BACKUP="/home/root/bt-keyboard/libepaper.so.original"
          if [ -f "/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf" ] && [ ! -f "$BACKUP_DIR/font_existed" ]; then
            touch "$BACKUP_DIR/font_existed"
          fi
          if [ ! -f "$LIBEPAPER_BACKUP" ] && [ -f "$LEGACY_LIBEPAPER_BACKUP" ]; then
            cp "$LEGACY_LIBEPAPER_BACKUP" "$LIBEPAPER_BACKUP"
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

        send("step", { step: 1, name: "원격 디렉토리 생성 및 백업", status: "complete" });

        // Step 1.5: 기존 서비스 중지
        try {
          await runSsh(
            ip,
            password,
            "systemctl stop hangul-daemon.service 2>/dev/null || true; systemctl stop hangul-restore.service 2>/dev/null || true",
          );
          send("log", { line: "OK: 기존 서비스 중지 완료" });
        } catch {
          // 서비스 미존재 시 무시
        }

        // === Step 2: 파일 업로드 ===
        const filesToUpload: FileMapping[] = [
          ...FILES_COMMON,
          ...(effectiveState.installBt ? FILES_BT : []),
        ];

        for (let i = 0; i < filesToUpload.length; i++) {
          const file = filesToUpload[i];
          // 절대 경로(캐시)인 경우 그대로 사용, 상대 경로는 projectDir 기준
          const localPath = path.isAbsolute(file.local) ? file.local : path.join(projectDir, file.local);

          if (!fs.existsSync(localPath)) {
            send("log", { line: `WARNING: ${file.local} not found, skipping` });
            continue;
          }

          send("step", { step: 2, name: `파일 업로드: ${file.remote}`, status: "running" });
          send("progress", {
            percent: 30 + Math.round(((i + 1) / filesToUpload.length) * 30),
            step: 2,
          });

          await runScp(
            ip,
            password,
            localPath,
            `/home/root/bt-keyboard/${file.remote}`,
          );
          send("log", { line: `OK: ${file.remote} uploaded` });
        }
        send("step", { step: 2, name: "파일 업로드 완료", status: "complete" });

        // === Step 3: 롤백 스크립트 업로드 ===
        send("step", { step: 3, name: "롤백 스크립트 설치", status: "running" });
        send("progress", { percent: 62, step: 3 });

        await runSsh(
          ip,
          password,
          `cat > /home/root/bt-keyboard/rollback.sh << 'ROLLBACK_EOF'\n${ROLLBACK_SCRIPT}ROLLBACK_EOF`,
        );
        await runSsh(ip, password, "chmod +x /home/root/bt-keyboard/rollback.sh");
        send("log", { line: "OK: rollback.sh 생성 (bash /home/root/bt-keyboard/rollback.sh 로 롤백)" });

        send("step", { step: 3, name: "롤백 스크립트 설치 완료", status: "complete" });

        // === Step 4: install.sh 실행 ===
        send("step", { step: 4, name: "설치 스크립트 실행", status: "running" });
        send("progress", { percent: 65, step: 4 });

        try {
          const installOutput = await runSsh(
            ip,
            password,
            `INSTALL_KEYPAD=${effectiveState.installKeypad ? "1" : "0"} INSTALL_BT=${effectiveState.installBt ? "1" : "0"} bash /home/root/bt-keyboard/install.sh`,
          );
          const lines = installOutput.split("\n");
          for (const line of lines) {
            if (line.trim()) {
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

        // === Step 5: 자동 복구 서비스 설치 ===
        if (effectiveState.installBt) {
          send("step", { step: 5, name: "부팅 시 자동 복구 서비스 설치", status: "running" });
          send("progress", { percent: 85, step: 5 });

          const restoreDir = path.join(os.tmpdir(), "ko-remark-install");
          const restoreScriptPath = path.join(restoreDir, "restore.sh");
          const restoreServicePath = path.join(restoreDir, "hangul-restore.service");
          fs.mkdirSync(restoreDir, { recursive: true });
          fs.writeFileSync(restoreScriptPath, RESTORE_SCRIPT);
          fs.writeFileSync(restoreServicePath, RESTORE_SERVICE);

          await runScp(
            ip,
            password,
            restoreScriptPath,
            "/home/root/bt-keyboard/restore.sh",
          );
          await runScp(
            ip,
            password,
            restoreServicePath,
            "/home/root/bt-keyboard/hangul-restore.service",
          );
          await runSsh(ip, password, "chmod +x /home/root/bt-keyboard/restore.sh");
          send("log", { line: "OK: restore.sh 생성" });

          await runSsh(
            ip,
            password,
            "cp /home/root/bt-keyboard/hangul-restore.service /etc/systemd/system/hangul-restore.service && systemctl daemon-reload && systemctl enable hangul-restore.service 2>/dev/null || true",
          );
          send("log", { line: "OK: hangul-restore.service 생성" });
          send("log", { line: "OK: hangul-restore 서비스 활성화" });

          await runSsh(
            ip,
            password,
            `ROOTFS_DEV=$(mount | grep ' / ' | head -n1 | awk '{print $1}') && mkdir -p /mnt/rootfs && mount -o rw "$ROOTFS_DEV" /mnt/rootfs 2>/dev/null && mkdir -p /mnt/rootfs/etc/systemd/system/multi-user.target.wants && cp /etc/systemd/system/hangul-restore.service /mnt/rootfs/etc/systemd/system/hangul-restore.service && ln -sf /etc/systemd/system/hangul-restore.service /mnt/rootfs/etc/systemd/system/multi-user.target.wants/hangul-restore.service && sync && umount /mnt/rootfs 2>/dev/null || true`,
          );
          send("log", { line: "OK: hangul-restore.service -> rootfs (reboot-safe)" });

          send("log", { line: "OK: install.sh가 post-update / factory-guard / swupdate 구성을 생성" });
          send("step", { step: 5, name: "부팅 시 자동 복구 서비스 설치 완료", status: "complete" });
        }

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
