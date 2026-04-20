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
  assert.equal(deriveRuntimeState({ hasHangulRuntime: false, hasBtConfig: false }), "clean");
  assert.equal(deriveRuntimeState({ hasHangulRuntime: true, hasBtConfig: false }), "hangul");
  assert.equal(deriveRuntimeState({ hasHangulRuntime: false, hasBtConfig: true }), "bt");
  assert.equal(deriveRuntimeState({ hasHangulRuntime: true, hasBtConfig: true }), "hangul_bt");
});

test("getSafetyStatus marks supported connected devices as safe", () => {
  const status = getSafetyStatus({
    connected: true,
    runtimeState: "hangul",
  });

  assert.equal(status.tone, "safe");
  assert.equal(status.label, "보증 영향 낮음");
});

test("getRecommendedAction points clean devices to the safe install flow", () => {
  const action = getRecommendedAction({
    connected: true,
    runtimeState: "clean",
  });

  assert.equal(action.id, "safe-install");
  assert.equal(action.href, "/install");
});

test("buildFailureRoutines returns BT guidance when BT checks fail", () => {
  const routines = buildFailureRoutines({
    connected: true,
    checks: [
      { id: "bt-config", pass: false },
    ],
  });

  assert.equal(routines[0].id, "bt-recovery");
});

test("buildOperationTimeline reflects update readiness", () => {
  const timeline = buildOperationTimeline({
    connected: true,
    runtimeState: "hangul_bt",
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
