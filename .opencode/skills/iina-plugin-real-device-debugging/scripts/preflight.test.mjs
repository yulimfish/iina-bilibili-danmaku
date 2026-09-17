import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateRepo } from "./preflight.mjs";

const scriptPath = fileURLToPath(new URL("./preflight.mjs", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "iina-plugin-preflight-"));
  mkdirSync(join(root, "tests"));
  writeFileSync(
    join(root, "Info.json"),
    JSON.stringify({ identifier: "test.plugin", entry: "main.js", globalEntry: "global.js" }),
  );
  writeFileSync(join(root, "main.js"), "const main = true;\n");
  writeFileSync(join(root, "global.js"), "const globalEntry = true;\n");
  writeFileSync(join(root, "tests", "smoke.test.js"), "require('node:test')('smoke', () => {});\n");
  return root;
}

function runPreflight(root) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [scriptPath, root], { encoding: "utf8", env });
}

test("accepts a structurally valid IINA JavaScript plugin repository", () => {
  const root = fixture();
  try {
    assert.deepEqual(validateRepo(root).errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a missing runtime entry before deployment", () => {
  const root = fixture();
  try {
    rmSync(join(root, "main.js"));
    assert.match(validateRepo(root).errors.join("\n"), /missing runtime entry: main\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports invalid Info.json and a missing test suite", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "Info.json"), "{not-json\n");
    rmSync(join(root, "tests"), { recursive: true });
    const errors = validateRepo(root).errors.join("\n");
    assert.match(errors, /invalid Info\.json/);
    assert.match(errors, /no tests\/\*\.test\.js files found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("propagates runtime syntax-check failures", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "main.js"), "const = broken;\n");
    const result = runPreflight(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FAIL syntax: main\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("propagates test process failures", () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, "tests", "smoke.test.js"),
      "throw new Error('expected failure');\n",
    );
    const result = runPreflight(root);
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /expected failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
