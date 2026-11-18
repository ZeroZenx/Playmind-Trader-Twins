import { spawnSync } from "node:child_process";

const steps = [
  ["syntax", "npm", ["run", "check"]],
  ["integration syntax", "node", ["--check", "scripts/migrate.mjs"]],
  ["worker syntax", "node", ["--check", "scripts/process-jobs.mjs"]],
  ["pipeline syntax", "node", ["--check", "src/engine/pipeline.mjs"]],
  ["runner syntax", "node", ["--check", "src/lib/twin-runner.mjs"]],
  ["tests", "npm", ["test"]],
  ["types", "npx", ["tsc", "--noEmit"]],
  ["production build", "npm", ["run", "build"]],
];

// On Windows npm and npx are .cmd shims, which Node spawns only through a shell. Every command
// and argument above is a constant, so the shell sees no outside input; it gets one string.
function run(command, args) {
  if (process.platform === "win32") return spawnSync([command, ...args].join(" "), { stdio: "inherit", shell: true });
  return spawnSync(command, args, { stdio: "inherit", shell: false });
}

for (const [name, command, args] of steps) {
  console.log(`\n[release] ${name}`);
  const result = run(command, args);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\n[release] verified");
