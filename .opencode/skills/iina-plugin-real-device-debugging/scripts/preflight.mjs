import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function collectFiles(root, predicate) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path, predicate));
    else if (predicate(path)) files.push(path);
  }
  return files;
}

export function validateRepo(repoPath) {
  const root = resolve(repoPath.replace(/^~(?=$|\/)/, homedir()));
  const errors = [];
  const infoPath = join(root, "Info.json");
  let info = null;

  if (!existsSync(infoPath)) {
    errors.push("missing Info.json");
  } else {
    try {
      info = JSON.parse(readFileSync(infoPath, "utf8"));
    } catch (error) {
      errors.push(`invalid Info.json: ${error.message}`);
    }
  }

  if (info) {
    if (!info.identifier) errors.push("Info.json is missing identifier");
    for (const key of ["entry", "globalEntry"]) {
      if (!info[key]) errors.push(`Info.json is missing ${key}`);
      else if (!existsSync(join(root, info[key]))) errors.push(`missing runtime entry: ${info[key]}`);
    }
  }

  const testFiles = collectFiles(join(root, "tests"), (path) => path.endsWith(".test.js"));
  if (testFiles.length === 0) errors.push("no tests/*.test.js files found");

  const runtimeFiles = info
    ? [info.entry, info.globalEntry]
        .filter(Boolean)
        .map((path) => join(root, path))
        .filter((path) => existsSync(path))
    : [];
  for (const directory of ["sidebar", "overlay"]) {
    runtimeFiles.push(
      ...collectFiles(join(root, directory), (path) => path.endsWith(".js") && !path.includes(`${directory}/vendor/`)),
    );
  }

  return { root, errors, testFiles, runtimeFiles: [...new Set(runtimeFiles)] };
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  return result.status === 0;
}

function main() {
  const result = validateRepo(process.argv[2] || process.cwd());
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`FAIL ${error}`);
    process.exitCode = 1;
    return;
  }

  for (const file of result.runtimeFiles) {
    if (!run(["--check", file], result.root)) {
      console.error(`FAIL syntax: ${basename(file)}`);
      process.exitCode = 1;
      return;
    }
  }
  if (!run(["--test", ...result.testFiles], result.root)) {
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${result.runtimeFiles.length} runtime files; ${result.testFiles.length} test files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
