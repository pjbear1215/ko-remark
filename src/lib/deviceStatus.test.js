import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFailureRoutines,
  buildOperationTimeline,
  deriveRuntimeState,
  getRecommendedAction,
  getSafetyStatus,
} from "./deviceStatus.js";

test("deriveRuntimeState returns the expected merged state", () => {
  assert.equal(deriveRuntimeState({ installKeypad: false, installBt: false }), "clean");
  assert.equal(deriveRuntimeState({ installKeypad: true, installBt: false }), "keypad_only");
  assert.equal(deriveRuntimeState({ installKeypad: false, installBt: true }), "bt_only");
  assert.equal(deriveRuntimeState({ installKeypad: true, installBt: true }), "both");
});

test("getSafetyStatus marks keypad without backups as recovery risk", () => {
  const status = getSafetyStatus({
    connected: true,
    runtimeState: "both",
    hasHomeBackup: false,
    hasOptBackup: false,
  });

  assert.equal(status.tone, "danger");
  assert.equal(status.label, "복구 차단 상태");
});

test("getRecommendedAction points clean devices to the safe install flow", () => {
  const action = getRecommendedAction({
    connected: true,
    runtimeState: "clean",
    hasRecoveryRisk: false,
  });

  assert.equal(action.id, "safe-install");
  assert.equal(action.href, "/install");
});

test("buildFailureRoutines returns BT guidance when BT checks fail", () => {
  const routines = buildFailureRoutines({
    connected: true,
    runtimeState: "bt_only",
    hasRecoveryRisk: false,
    checks: [
      { id: "bt-daemon", pass: false },
    ],
  });

  assert.equal(routines[0].id, "bt-recovery");
});

test("buildOperationTimeline reflects update readiness", () => {
  const timeline = buildOperationTimeline({
    connected: true,
    runtimeState: "both",
    checks: [
      { id: "reboot-ready", pass: true },
      { id: "inactive-slot", pass: false },
      { id: "factory-guard", pass: true },
    ],
  });

  assert.equal(timeline[2].status, "done");
  assert.equal(timeline[3].status, "pending");
  assert.equal(timeline[4].status, "done");
});
