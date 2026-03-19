import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { buildBluetoothKeyboardCleanupScript } from "@/lib/bluetoothCleanup.js";

function runSshOnce(
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
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    proc.on("error", reject);
  });
}

async function runSsh(
  ip: string,
  password: string,
  command: string,
  retries = 3,
): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      return await runSshOnce(ip, password, command);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries - 1 && msg.includes("Permission denied")) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("SSH connection failed after retries");
}

async function detect(ip: string, password: string): Promise<{ keypad: boolean; bt: boolean }> {
  const output = await runSsh(ip, password, `
    strings /usr/bin/xochitl 2>/dev/null | grep -q "/home/root/.kbds/" && echo "KEYPAD=yes" || echo "KEYPAD=no"
    if [ -f /home/root/bt-keyboard/hangul-daemon ] || systemctl is-enabled hangul-daemon 2>/dev/null | grep -q enabled; then
      echo "BT=yes"
    else
      echo "BT=no"
    fi
  `);
  return {
    keypad: output.includes("KEYPAD=yes"),
    bt: output.includes("BT=yes"),
  };
}

async function removeBt(ip: string, password: string, otherStillInstalled: boolean): Promise<string[]> {
  const logs: string[] = [];

  // 모든 서비스 중지 및 비활성화 (하나의 세션에서)
  await runSsh(ip, password, `
    systemctl stop hangul-daemon 2>/dev/null || true
    systemctl disable hangul-daemon 2>/dev/null || true
    killall hangul-daemon 2>/dev/null || true
    systemctl daemon-reload
  `);
  logs.push("OK: hangul-daemon 중지 및 비활성화");

  // remount + 모든 rootfs 작업을 하나의 세션에서 실행
  const result = await runSsh(ip, password, `
    mount -o remount,rw / || { echo "FAIL:remount"; exit 0; }
    rm -f /etc/systemd/system/hangul-daemon.service
    rm -f /etc/systemd/system/multi-user.target.wants/hangul-daemon.service
    rm -f /etc/modules-load.d/btnxpuart.conf
    rm -f /etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
    rmdir /etc/systemd/system/bluetooth.service.d 2>/dev/null || true
    sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
    sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true
    rm -f /home/root/bt-keyboard/hangul-daemon
    echo "BT_REMOVE_OK"
  `);
  if (result.includes("FAIL:remount")) {
    logs.push("WARNING: rootfs remount 실패");
  } else {
    logs.push("OK: hangul-daemon 서비스 파일 및 바이너리 제거");
  }

  const btCleanupResult = await runSsh(ip, password, buildBluetoothKeyboardCleanupScript());
  const removedCountMatch = btCleanupResult.match(/BT_KEYBOARD_REMOVED_COUNT=(\d+)/);
  const removedCount = removedCountMatch ? Number.parseInt(removedCountMatch[1], 10) : 0;
  logs.push(`OK: 블루투스 키보드 페어링 정리 (${removedCount}개)`);

  // 비활성 파티션 정리
  await runSsh(ip, password, `
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
        rm -f /mnt/inactive/etc/systemd/system/hangul-daemon.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
        rm -f /mnt/inactive/etc/modules-load.d/btnxpuart.conf
        rm -f /mnt/inactive/etc/systemd/system/bluetooth.service.d/wait-for-hci.conf
        rmdir /mnt/inactive/etc/systemd/system/bluetooth.service.d 2>/dev/null || true
        sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/inactive/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
        sed -i '/^Privacy = off$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
        sync
      fi
      umount /mnt/inactive 2>/dev/null || true
    fi
  `);
  logs.push("OK: 비활성 파티션 BT 흔적 제거");

  // 다른 설치 상태도 없으면 공통 파일도 정리
  if (!otherStillInstalled) {
    await cleanupCommon(ip, password, logs);
  }

  await runSsh(ip, password, "systemctl daemon-reload");
  logs.push("OK: systemctl daemon-reload");

  return logs;
}

async function removeOnscreen(ip: string, password: string, otherStillInstalled: boolean): Promise<string[]> {
  const logs: string[] = [];

  // 1. 모든 관련 서비스 중지 및 비활성화 (하나의 세션)
  await runSsh(ip, password, `
    systemctl stop xochitl 2>/dev/null || true
    systemctl stop hangul-restore 2>/dev/null || true
    systemctl stop hangul-factory-guard 2>/dev/null || true
    systemctl stop hangul-daemon 2>/dev/null || true
    systemctl disable hangul-restore 2>/dev/null || true
    systemctl disable hangul-factory-guard 2>/dev/null || true
    systemctl disable hangul-daemon 2>/dev/null || true
    systemctl daemon-reload
  `);
  logs.push("OK: 모든 hangul 서비스 중지 및 비활성화");

  // 2. remount + xochitl 복원 + rootfs 파일 제거 (하나의 세션)
  const mainResult = await runSsh(ip, password, `
    RESULTS=""
    mount -o remount,rw / || { echo "FAIL:remount"; exit 0; }

    # xochitl 원본 복원
    BACKUP=""
    if [ -f "/home/root/bt-keyboard/backup/xochitl.original" ]; then
      BACKUP="/home/root/bt-keyboard/backup/xochitl.original"
    elif [ -f "/opt/bt-keyboard/xochitl.original" ]; then
      BACKUP="/opt/bt-keyboard/xochitl.original"
    fi
    if [ -n "$BACKUP" ]; then
      BACKUP_SIZE=$(stat -c %s "$BACKUP" 2>/dev/null)
      CURRENT_SIZE=$(stat -c %s /usr/bin/xochitl 2>/dev/null)
      if [ "$BACKUP_SIZE" = "$CURRENT_SIZE" ] && strings "$BACKUP" 2>/dev/null | grep -q ":/misc/keyboards/"; then
        cp "$BACKUP" /usr/bin/xochitl && chmod 755 /usr/bin/xochitl && RESULTS="$RESULTS XOCHITL_OK" || RESULTS="$RESULTS XOCHITL_FAIL"
      else
        RESULTS="$RESULTS XOCHITL_MISMATCH"
      fi
    else
      RESULTS="$RESULTS XOCHITL_NO_BACKUP"
    fi

    # libepaper 원본 복원
    if [ -f /home/root/bt-keyboard/backup/libepaper.so.original ]; then
      cp /home/root/bt-keyboard/backup/libepaper.so.original /usr/lib/plugins/platforms/libepaper.so 2>/dev/null || true
    fi

    # LD_PRELOAD 오버라이드 제거
    rm -f /etc/systemd/system/xochitl.service.d/override.conf
    rm -f /etc/systemd/system/xochitl.service.d/zz-hangul-hook.conf
    rmdir /etc/systemd/system/xochitl.service.d 2>/dev/null || true
    rm -f /usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf

    # 서비스 파일 제거
    rm -f /etc/systemd/system/hangul-daemon.service
    rm -f /etc/systemd/system/hangul-restore.service
    rm -f /etc/systemd/system/hangul-factory-guard.service
    rm -f /etc/systemd/system/multi-user.target.wants/hangul-daemon.service
    rm -f /etc/systemd/system/multi-user.target.wants/hangul-restore.service
    rm -f /etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service

    # 폰트 제거
    rm -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf
    fc-cache -f 2>/dev/null || true

    # factory-guard, swupdate hook 제거
    rm -f /etc/swupdate/conf.d/99-hangul-postupdate
    rm -f /opt/bt-keyboard/factory-guard.sh
    rm -f /opt/bt-keyboard/xochitl.original
    rm -f /opt/bt-keyboard/hangul_hook.so
    rmdir /opt/bt-keyboard 2>/dev/null || true

    # bluetooth 원복
    sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
    sed -i '/^Privacy = off$/d' /etc/bluetooth/main.conf 2>/dev/null || true

    echo "$RESULTS ROOTFS_DONE"
  `);

  if (mainResult.includes("FAIL:remount")) {
    logs.push("ERROR: rootfs remount 실패 — 제거 불가");
    return logs;
  }
  if (mainResult.includes("XOCHITL_OK")) {
    logs.push("OK: xochitl 원본 바이너리 복원");
  } else if (mainResult.includes("XOCHITL_FAIL")) {
    logs.push("WARNING: xochitl cp 실패");
  } else if (mainResult.includes("XOCHITL_NO_BACKUP")) {
    logs.push("WARNING: xochitl 백업 파일 없음");
  } else {
    logs.push("WARNING: xochitl 복원 실패 (크기 불일치)");
  }
  logs.push("OK: LD_PRELOAD, 서비스 파일, 폰트, factory-guard 제거");

  // 3. /home 파일 제거 (별도 — /home은 별도 파티션)
  await runSsh(ip, password, `
    find /home/root/.kbds -type f -delete 2>/dev/null || true
    find /home/root/.kbds -type d -empty -delete 2>/dev/null || true
    rmdir /home/root/.kbds 2>/dev/null || true
  `);
  logs.push("OK: .kbds 키보드 레이아웃 제거");

  // 4. 키보드 설정 복원 ([General] 섹션 안에 삽입)
  await runSsh(ip, password, `
    CONF="/home/root/.config/remarkable/xochitl.conf"
    if [ -f "$CONF" ]; then
      sed -i '/^Keyboard=/d' "$CONF"
      if grep -q '^\\[General\\]' "$CONF"; then
        sed -i '/^\\[General\\]/a\\Keyboard=en_US' "$CONF"
      else
        echo "Keyboard=en_US" >> "$CONF"
      fi
    fi
  `);
  logs.push("OK: 키보드 설정 복원 (en_US)");

  // 5. 비활성 파티션 정리
  await runSsh(ip, password, `
    CURRENT=$(mount | grep ' / ' | head -n 1 | awk '{print $1}')
    case "$CURRENT" in
      /dev/mmcblk0p2) INACTIVE=/dev/mmcblk0p3 ;;
      /dev/mmcblk0p3) INACTIVE=/dev/mmcblk0p2 ;;
      *) INACTIVE="" ;;
    esac
    if [ -n "$INACTIVE" ]; then
      mkdir -p /mnt/inactive
      mount -o rw "$INACTIVE" /mnt/inactive 2>/dev/null || true
      if [ -d /mnt/inactive/usr ]; then
        if [ -f /mnt/inactive/opt/bt-keyboard/xochitl.original ]; then
          cp /mnt/inactive/opt/bt-keyboard/xochitl.original /mnt/inactive/usr/bin/xochitl
          chmod 755 /mnt/inactive/usr/bin/xochitl
        fi
        rm -f /mnt/inactive/opt/bt-keyboard/factory-guard.sh /mnt/inactive/opt/bt-keyboard/xochitl.original /mnt/inactive/opt/bt-keyboard/hangul_hook.so
        rmdir /mnt/inactive/opt/bt-keyboard 2>/dev/null || true
        rm -f /mnt/inactive/usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf
        rm -f /mnt/inactive/etc/swupdate/conf.d/99-hangul-postupdate
        rm -f /mnt/inactive/etc/systemd/system/xochitl.service.d/override.conf
        rm -f /mnt/inactive/etc/systemd/system/xochitl.service.d/zz-hangul-hook.conf
        rmdir /mnt/inactive/etc/systemd/system/xochitl.service.d 2>/dev/null || true
        rm -f /mnt/inactive/usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf
        rm -f /mnt/inactive/etc/systemd/system/hangul-daemon.service
        rm -f /mnt/inactive/etc/systemd/system/hangul-restore.service
        rm -f /mnt/inactive/etc/systemd/system/hangul-factory-guard.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-daemon.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-restore.service
        rm -f /mnt/inactive/etc/systemd/system/multi-user.target.wants/hangul-factory-guard.service
        sed -i 's|^##*ConditionPathIsDirectory=/sys/class/bluetooth|ConditionPathIsDirectory=/sys/class/bluetooth|' /mnt/inactive/usr/lib/systemd/system/bluetooth.service 2>/dev/null || true
        sed -i '/^Privacy = off$/d' /mnt/inactive/etc/bluetooth/main.conf 2>/dev/null || true
        sync
      fi
      umount /mnt/inactive 2>/dev/null || true
    fi
  `);
  logs.push("OK: 비활성 파티션 기존 설치 상태 정리");

  // 6. BT도 없으면 공통 파일도 정리
  if (!otherStillInstalled) {
    await cleanupCommon(ip, password, logs);
  }

  // 7. daemon-reload + xochitl 재시작
  await runSsh(ip, password, "systemctl daemon-reload && systemctl restart xochitl 2>/dev/null || true");
  logs.push("OK: xochitl 재시작");

  // 8. 최종 검증
  const verify = await runSsh(ip, password, `
    FAIL=""
    strings /usr/bin/xochitl 2>/dev/null | grep -q "/home/root/.kbds/" && FAIL="$FAIL xochitl_still_patched"
    [ -d /etc/systemd/system/xochitl.service.d ] && FAIL="$FAIL override_exists"
    [ -f /usr/lib/systemd/system/xochitl.service.d/zz-hangul-hook.conf ] && FAIL="$FAIL usr_hook_dropin_exists"
    [ -d /home/root/.kbds ] && FAIL="$FAIL kbds_exists"
    [ -f /usr/share/fonts/ttf/noto/NotoSansCJKkr-Regular.otf ] && FAIL="$FAIL font_exists"
    [ -d /opt/bt-keyboard ] && FAIL="$FAIL opt_exists"
    [ -d /home/root/bt-keyboard ] && FAIL="$FAIL bt_keyboard_exists"
    [ -f /etc/swupdate/conf.d/99-hangul-postupdate ] && FAIL="$FAIL swupdate_hook_exists"
    KB_COUNT=$(grep -c '^Keyboard=' /home/root/.config/remarkable/xochitl.conf 2>/dev/null || echo 0)
    [ "$KB_COUNT" -gt 1 ] && FAIL="$FAIL keyboard_duplicate"
    if [ -z "$FAIL" ]; then echo "VERIFY_OK"; else echo "VERIFY_FAIL:$FAIL"; fi
  `);
  const verifyTrimmed = verify.trim();
  if (verifyTrimmed === "VERIFY_OK") {
    logs.push("OK: 제거 검증 완료");
  } else {
    logs.push(`WARNING: 일부 항목 미제거 — ${verifyTrimmed}`);
  }

  return logs;
}

async function cleanupCommon(ip: string, password: string, logs: string[]): Promise<void> {
  // .bashrc 정리
  await runSsh(ip, password, `
    if [ -f /home/root/.bashrc ] && grep -q 'bt-keyboard' /home/root/.bashrc 2>/dev/null; then
      rm -f /home/root/.bashrc
    fi
  `);
  logs.push("OK: .bashrc 자동복구 스크립트 제거");

  // bt-keyboard 디렉토리 전체 제거
  await runSsh(ip, password, `
    find /home/root/bt-keyboard -type f -delete 2>/dev/null || true
    find /home/root/bt-keyboard -type d -empty -delete 2>/dev/null || true
    rm -rf /home/root/bt-keyboard 2>/dev/null || true
  `);
  logs.push("OK: bt-keyboard 디렉토리 전체 제거");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { ip, password, target } = body as { ip: string; password: string; target: string };

    if (!ip || !password || !target) {
      return NextResponse.json({ success: false, error: "ip, password, target 필수" }, { status: 400 });
    }

    if (!/^[\d.]+$/.test(ip)) {
      return NextResponse.json({ success: false, error: "Invalid IP" }, { status: 400 });
    }

    if (target !== "bt" && target !== "onscreen") {
      return NextResponse.json({ success: false, error: "target은 bt 또는 onscreen" }, { status: 400 });
    }

    // 현재 설치 상태 감지
    const detected = await detect(ip, password);

    if (target === "bt" && !detected.bt) {
      return NextResponse.json({ success: false, error: "블루투스 한글 키보드가 설치되어 있지 않습니다" });
    }

    if (target === "onscreen" && !detected.keypad) {
    return NextResponse.json({ success: false, error: "해당 설치 항목이 감지되지 않습니다" });
    }

    const otherStillInstalled = target === "bt" ? detected.keypad : detected.bt;

    const logs = target === "bt"
      ? await removeBt(ip, password, otherStillInstalled)
      : await removeOnscreen(ip, password, otherStillInstalled);

    return NextResponse.json({ success: true, logs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
