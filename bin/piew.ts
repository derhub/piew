#!/usr/bin/env bun
import {
  diffCommand,
  openCommand,
  pollCommand,
  respondCommand,
  statusCommand,
} from "../src/cli/index";

const HELP = `piew - portable review

Usage:
  piew <file-or-url> [files...]       Open markdown or source file(s) for review
      --wait                          Open, then block until feedback arrives
  piew diff [range]                   Open a git diff for review
      --staged                        Diff the index against HEAD
      --wait                          Open, then block until feedback arrives
  piew poll <target>                  Wait for human feedback and output JSON (for agents)
      --ack                           Acknowledge last batch and keep waiting
      --timeout <secs>                Exit with timeout status if no feedback arrives
  piew respond <target>               Answer the batch you were given; JSON on stdin
  piew status <target>                Check whether feedback is waiting without blocking

A diff session is polled by the target the diff command prints, not by a path:
  piew poll "git:/repo/root:main..feat"

--wait opens and polls in one command, so a diff needs no target at all:
  piew diff main..feat --wait --timeout 600

respond takes the verdicts on stdin, one entry per annotation you were sent:
  echo '{"note":"done","items":[{"id":"c_1","status":"applied"}]}' | piew respond spec.md

Local review tool powered by Bun, TanStack Router, and Base UI.
`;

const argv = process.argv.slice(2);

if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

if (argv.includes("-v") || argv.includes("--version")) {
  console.log("2.0.0");
  process.exit(0);
}

/** Shared by poll and by --wait, so both spell the flag the same way. */
function timeoutFrom(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--timeout") return Number(args[i + 1]) || 0;
    if (arg.startsWith("--timeout=")) return Number(arg.slice(10)) || 0;
  }
  return 0;
}

const command = argv[0];
const wait = argv.includes("--wait");

if (command === "poll") {
  let ack = false;
  let timeoutSecs = 0;
  let file = "";

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ack") ack = true;
    else if (arg === "--timeout") {
      timeoutSecs = Number(argv[++i]) || 0;
    } else if (arg.startsWith("--timeout=")) {
      timeoutSecs = Number(arg.slice(10)) || 0;
    } else if (!arg.startsWith("-") && !file) {
      file = arg;
    }
  }

  if (!file) {
    console.error("Usage: piew poll <file-or-url> [--ack] [--timeout <secs>]");
    process.exit(1);
  }

  await pollCommand(file, { ack, timeoutSecs });
} else if (command === "diff") {
  const staged = argv.includes("--staged") || argv.includes("--cached");
  const range = argv.slice(1).find((a, i) => !a.startsWith("-") && argv[i] !== "--timeout") || "";
  const target = await diffCommand(range, { staged });
  if (wait && target) await pollCommand(target, { timeoutSecs: timeoutFrom(argv) });
} else if (command === "respond") {
  const target = argv.slice(1).find((a) => !a.startsWith("-"));
  if (!target) {
    console.error("Usage: piew respond <target> < response.json");
    process.exit(1);
  }
  await respondCommand(target, await Bun.stdin.text());
} else if (command === "status") {
  const file = argv.slice(1).find((a) => !a.startsWith("-"));
  if (!file) {
    console.error("Usage: piew status <file-or-url>");
    process.exit(1);
  }
  await statusCommand(file);
} else {
  // All non-flag arguments are file paths, except the value --timeout takes.
  const files = argv.filter((a, i) => !a.startsWith("-") && argv[i - 1] !== "--timeout");
  const target = await openCommand(files);
  if (wait) await pollCommand(target, { timeoutSecs: timeoutFrom(argv) });
}
