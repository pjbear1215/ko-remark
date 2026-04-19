import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const resourcesDir = path.resolve(process.cwd(), "resources");
const restoreServiceContent = fs.readFileSync(path.join(resourcesDir, "rekoit-restore.service"), "utf8");
const restoreScriptContent = fs.readFileSync(path.join(resourcesDir, "restore.sh"), "utf8");

test("restore service starts before xochitl during boot recovery", () => {
  assert.ok(restoreServiceContent.length > 0, "restore service content not found");
  assert.match(restoreServiceContent, /Before=xochitl\.service/);
});

test("restore script identifies itself and handles state", () => {
  assert.ok(restoreScriptContent.length > 0, "restore script content not found");
  assert.match(restoreScriptContent, /STATE_FILE="\$BASEDIR\/install-state\.conf"/);
});
