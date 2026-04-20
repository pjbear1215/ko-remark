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
  const keyboardScanScript = buildKeyboardBluetoothAddressScanScript().trim();
  return `
TARGET_ADDRS=$(
  {
    bluetoothctl devices 2>/dev/null || true
    bluetoothctl devices Paired 2>/dev/null || true
    bluetoothctl devices Trusted 2>/dev/null || true
    bluetoothctl devices Connected 2>/dev/null || true
  } | awk '/^Device [0-9A-F:]+/ {print $2}'
  find /var/lib/bluetooth -mindepth 2 -maxdepth 2 -type d 2>/dev/null | awk -F/ '
    /^[0-9A-F:]{17}$/ && $(NF-1) != "cache" {print $NF}
  '
  ${keyboardScanScript}
)
TARGET_ADDRS=$(printf '%s\n' "$TARGET_ADDRS" | awk '/^[0-9A-F:]{17}$/ {print $1}' | awk '!seen[$0]++')
REMOVED_COUNT=0

for ADDR in $TARGET_ADDRS; do
  [ -n "$ADDR" ] || continue
  bluetoothctl disconnect "$ADDR" 2>/dev/null || true
  bluetoothctl untrust "$ADDR" 2>/dev/null || true
  bluetoothctl remove "$ADDR" 2>/dev/null || true
  for ADAPTER in /var/lib/bluetooth/*; do
    [ -d "$ADAPTER" ] || continue
    rm -rf "$ADAPTER/$ADDR" "$ADAPTER/cache/$ADDR" 2>/dev/null || true
  done
  REMOVED_COUNT=$((REMOVED_COUNT + 1))
done

for ADAPTER in /var/lib/bluetooth/*; do
  [ -d "$ADAPTER" ] || continue
  find "$ADAPTER" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while read -r ENTRY; do
    BASENAME=$(basename "$ENTRY")
    case "$BASENAME" in
      cache) continue ;;
    esac
    printf '%s\n' "$BASENAME" | grep -Eq '^[0-9A-F:]{17}$' || continue
    rm -rf "$ENTRY" "$ADAPTER/cache/$BASENAME" 2>/dev/null || true
  done
done
find /var/lib/bluetooth -path '*/cache/*' -type d -exec rm -rf {} + 2>/dev/null || true

echo "BT_KEYBOARD_REMOVED_COUNT=$REMOVED_COUNT"
`;
}
