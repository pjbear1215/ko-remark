export function isKeyboardBluetoothInfo(output) {
  const text = output ?? "";
  return (
    text.includes("Icon: input-keyboard") ||
    text.includes("UUID: Human Interface Device")
  );
}

export function buildKeyboardBluetoothAddressScanScript() {
  return `
find /var/lib/bluetooth -path '*/cache' -prune -o -type f -name info -print 2>/dev/null |
while read -r INFO_FILE; do
  INFO=$(cat "$INFO_FILE" 2>/dev/null || true)
  case "$INFO" in
    *"Icon=input-keyboard"*|*"UUID=Human Interface Device"*|*"00001124-0000-1000-8000-00805f9b34fb"*)
      basename "$(dirname "$INFO_FILE")"
      ;;
  esac
done | awk 'NF' | sort -u
`;
}

export function buildBluetoothKeyboardCleanupScript() {
  const scanScript = buildKeyboardBluetoothAddressScanScript().trim();
  return `
TARGET_ADDRS=$(
${scanScript}
)
REMOVED_COUNT=0

for ADDR in $TARGET_ADDRS; do
  for ADAPTER in /var/lib/bluetooth/*; do
    [ -d "$ADAPTER" ] || continue
    rm -rf "$ADAPTER/$ADDR" "$ADAPTER/cache/$ADDR" 2>/dev/null || true
  done
  REMOVED_COUNT=$((REMOVED_COUNT + 1))
done

echo "BT_KEYBOARD_REMOVED_COUNT=$REMOVED_COUNT"
`;
}
