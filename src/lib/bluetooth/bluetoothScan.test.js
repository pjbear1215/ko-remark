import test from "node:test";
import assert from "node:assert/strict";

import {
  extractDiscoveredDevice,
  extractObservedDeviceAddress,
  isDisplayableBluetoothDeviceName,
} from "./bluetoothScan.js";

test("extractDiscoveredDevice parses NEW device lines from bluetoothctl scan output", () => {
  assert.deepEqual(
    extractDiscoveredDevice("[NEW] Device D6:A6:54:68:75:8D Keys-To-Go 2"),
    {
      address: "D6:A6:54:68:75:8D",
      name: "Keys-To-Go 2",
    },
  );
});

test("extractDiscoveredDevice ignores non-discovery lines", () => {
  assert.equal(extractDiscoveredDevice("Changing pairable on succeeded"), null);
});

test("extractDiscoveredDevice parses CHG name lines from bluetoothctl scan output", () => {
  assert.deepEqual(
    extractDiscoveredDevice("[CHG] Device D6:A6:54:68:75:8D Name: Keys-To-Go 2"),
    {
      address: "D6:A6:54:68:75:8D",
      name: "Keys-To-Go 2",
    },
  );
});

test("extractDiscoveredDevice parses CHG alias lines from bluetoothctl scan output", () => {
  assert.deepEqual(
    extractDiscoveredDevice("[CHG] Device D6:A6:54:68:75:8D Alias: HHKB-Hybrid_2"),
    {
      address: "D6:A6:54:68:75:8D",
      name: "HHKB-Hybrid_2",
    },
  );
});

test("extractDiscoveredDevice ignores effectively unnamed devices", () => {
  assert.equal(
    extractDiscoveredDevice("[NEW] Device D6:A6:54:68:75:8D unknown"),
    null,
  );
});

test("isDisplayableBluetoothDeviceName rejects blank and unknown names", () => {
  assert.equal(isDisplayableBluetoothDeviceName(""), false);
  assert.equal(isDisplayableBluetoothDeviceName("unknown"), false);
  assert.equal(isDisplayableBluetoothDeviceName("(unknown)"), false);
  assert.equal(isDisplayableBluetoothDeviceName("63:1D:A5:C9:10:24"), false);
  assert.equal(isDisplayableBluetoothDeviceName("AA-BB-CC-DD"), true);
  assert.equal(isDisplayableBluetoothDeviceName("40-BA-96-0C-D3-01"), false);
  assert.equal(isDisplayableBluetoothDeviceName("HHKB-Hybrid_2"), true);
});

test("extractDiscoveredDevice ignores address-only names", () => {
  assert.equal(
    extractDiscoveredDevice("[NEW] Device 63:1D:A5:C9:10:24 63:1D:A5:C9:10:24"),
    null,
  );
});

test("extractObservedDeviceAddress parses CHG device lines", () => {
  assert.equal(
    extractObservedDeviceAddress("[CHG] Device D6:A6:54:68:75:8D RSSI: 0xffffffcd (-51)"),
    "D6:A6:54:68:75:8D",
  );
});

test("extractObservedDeviceAddress also parses NEW device lines", () => {
  assert.equal(
    extractObservedDeviceAddress("[NEW] Device D6:A6:54:68:75:8D Keys-To-Go 2"),
    "D6:A6:54:68:75:8D",
  );
});
