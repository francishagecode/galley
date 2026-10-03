// Builds the Rust native module (native/) and copies it to native/galley.node.
//   node scripts/build-native.js [--debug]
// Runs at low priority with capped parallelism so it doesn't swamp the machine.
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { availableParallelism } from "node:os";

const debug = process.argv.includes("--debug");
const jobs = String(Math.max(1, Math.min(6, availableParallelism() - 2)));
const cargo = [
  "cargo",
  "build",
  "-p",
  "galley-native",
  "-j",
  jobs,
  ...(debug ? [] : ["--release"]),
];
const [command, args] =
  process.platform === "win32" ? [cargo[0], cargo.slice(1)] : ["nice", ["-n", "19", ...cargo]];
execFileSync(command, args, { stdio: "inherit" });

const lib =
  { darwin: "libgalley_native.dylib", win32: "galley_native.dll" }[process.platform] ??
  "libgalley_native.so";
copyFileSync(`target/${debug ? "debug" : "release"}/${lib}`, "native/galley.node");
