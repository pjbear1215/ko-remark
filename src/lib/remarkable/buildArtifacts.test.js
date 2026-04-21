import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { shouldRebuildArtifact } from "./buildArtifacts.js";

test("shouldRebuildArtifact returns true when output is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rekoit-build-"));
  const source = path.join(dir, "source.c");
  fs.writeFileSync(source, "int main(void){return 0;}");

  assert.equal(
    shouldRebuildArtifact(path.join(dir, "missing.so"), [source]),
    true,
  );
});

test("shouldRebuildArtifact returns true when source is newer than output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rekoit-build-"));
  const source = path.join(dir, "source.c");
  const output = path.join(dir, "artifact.so");
  fs.writeFileSync(output, "old");
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(source, "new");

  assert.equal(shouldRebuildArtifact(output, [source]), true);
});

test("shouldRebuildArtifact returns false when output is newer than all sources", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rekoit-build-"));
  const source = path.join(dir, "source.c");
  const output = path.join(dir, "artifact.so");
  fs.writeFileSync(source, "old");
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(output, "new");

  assert.equal(shouldRebuildArtifact(output, [source]), false);
});

test("shouldRebuildArtifact returns true when any source is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rekoit-build-"));
  const output = path.join(dir, "artifact.so");
  fs.writeFileSync(output, "built");

  assert.equal(
    shouldRebuildArtifact(output, [path.join(dir, "missing-source.c")]),
    true,
  );
});
