import { sanitizeBluetoothLine } from "./bluetoothPairing.js";

export function isDisplayableBluetoothDeviceName(name) {
  const normalized = (name ?? "").trim();
  if (!normalized) return false;

  const lowered = normalized.toLowerCase();
  if (lowered === "unknown" || lowered === "(unknown)" || lowered === "n/a") {
    return false;
  }
  if (/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(normalized)) {
    return false;
  }
  if (/^[0-9a-f]{2}(?:-[0-9a-f]{2}){5}$/i.test(normalized)) {
    return false;
  }

  return true;
}

export function extractDiscoveredDevice(line) {
  const stripped = sanitizeBluetoothLine(line);
  const newMatch = stripped.match(/\[NEW\]\s+Device\s+([0-9A-F:]+)\s+(.+)$/i);
  if (newMatch) {
    const name = newMatch[2].trim();
    if (!isDisplayableBluetoothDeviceName(name)) {
      return null;
    }
    return {
      address: newMatch[1],
      name,
    };
  }

  const changedNameMatch = stripped.match(
    /\[CHG\]\s+Device\s+([0-9A-F:]+)\s+(?:Name|Alias):\s+(.+)$/i,
  );
  if (changedNameMatch) {
    const name = changedNameMatch[2].trim();
    if (!isDisplayableBluetoothDeviceName(name)) {
      return null;
    }
    return {
      address: changedNameMatch[1],
      name,
    };
  }

  return null;
}

export function extractObservedDeviceAddress(line) {
  const stripped = sanitizeBluetoothLine(line);
  const match = stripped.match(/\[(?:NEW|CHG)\]\s+Device\s+([0-9A-F:]+)\b/i);
  return match ? match[1] : null;
}
