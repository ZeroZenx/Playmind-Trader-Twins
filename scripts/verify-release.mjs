import { spawnSync } from "node:child_process";

const steps = [
  ["syntax", "npm", ["run", "check"]],
  ["tests", "npm", ["test"]],
  ["types", "npx", ["tsc", "--noEmit"]],
  ["production build", "npm", ["run", "build"]],
];

for (const [name, command, args] of steps) {
  console.log(`\n[release] ${name}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\n[release] verified");
