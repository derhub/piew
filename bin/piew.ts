#!/usr/bin/env bun
import {
  diffCommand,
  mapCommand,
  openCommand,
  pollCommand,
  pruneCommand,
  respondCommand,
  restartCommand,
  statusCommand,
} from "../src/cli/index";
import { toolsCommand } from "../src/cli/tools";

const HELP = `piew - portable review

Usage:
  piew <file-or-url> [files...]       Open markdown or source file(s) for review
      --wait                          Open, then block until feedback arrives
  piew diff [range]                   Open a git diff for review
      --staged                        Diff the index against HEAD
      --wait                          Open, then block until feedback arrives
  piew map <session-id> --show        Print the current Review Map
  piew map <session-id>               Replace the Review Map; JSON on stdin
  piew poll <session-id>              Wait for human feedback and output JSON (for agents)
      --ack                           Acknowledge last batch and keep waiting
      --timeout <secs>                Exit with timeout status if no feedback arrives
  piew respond <session-id>           Answer the batch you were given; JSON on stdin
  piew status <session-id>            Check whether feedback is waiting without blocking
  piew prune                          Remove all stored Piew sessions and session state
  piew restart                        Restart the local review daemon

Open and diff print compact JSON with the session ID used by every follow-up command:
  piew poll s_123

Show the current Review Map:
  piew map s_123 --show

Replace the whole Review Map with ordered slash paths and existing pages or files:
  echo '{"title":"Release review","items":[{"path":"Web/Auth/login.ts","source":{"kind":"page","pageId":"p_123"}},{"path":"API/Auth/route.ts","source":{"kind":"file","file":"/abs/api/route.ts"}}]}' | piew map s_123

--wait opens and polls in one command, so a diff needs no target at all:
  piew diff main..feat --wait --timeout 600

respond takes the verdicts on stdin, one entry per annotation you were sent:
  echo '{"note":"done","items":[{"id":"c_1","status":"applied"}]}' | piew respond s_123

Local review tool powered by Bun, TanStack Router, and Base UI.
`;

const argv = process.argv.slice(2);
const command = argv[0];

if (command === "tools") {
  await toolsCommand(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}

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

const wait = argv.includes("--wait");

if (command === "poll") {
  let ack = false;
  let timeoutSecs = 0;
  let sessionId = "";

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ack") ack = true;
    else if (arg === "--timeout") {
      timeoutSecs = Number(argv[++i]) || 0;
    } else if (arg.startsWith("--timeout=")) {
      timeoutSecs = Number(arg.slice(10)) || 0;
    } else if (!arg.startsWith("-") && !sessionId) {
      sessionId = arg;
    }
  }

  if (!sessionId) {
    console.error("Usage: piew poll <session-id> [--ack] [--timeout <secs>]");
    process.exit(1);
  }

  await pollCommand(sessionId, { ack, timeoutSecs });
} else if (command === "diff") {
  const staged = argv.includes("--staged") || argv.includes("--cached");
  const range = argv.slice(1).find((a, i) => !a.startsWith("-") && argv[i] !== "--timeout") || "";
  const sessionId = await diffCommand(range, { staged });
  if (wait && sessionId) await pollCommand(sessionId, { timeoutSecs: timeoutFrom(argv) });
} else if (command === "map") {
  const sessionId = argv.slice(1).find((arg) => !arg.startsWith("-"));
  if (!sessionId) {
    console.error("Usage: piew map <session-id> [--show] < review-map.json");
    process.exit(1);
  }
  await mapCommand(sessionId, argv.includes("--show") ? undefined : await Bun.stdin.text());
} else if (command === "respond") {
  const sessionId = argv.slice(1).find((a) => !a.startsWith("-"));
  if (!sessionId) {
    console.error("Usage: piew respond <session-id> < response.json");
    process.exit(1);
  }
  await respondCommand(sessionId, await Bun.stdin.text());
} else if (command === "status") {
  const sessionId = argv.slice(1).find((a) => !a.startsWith("-"));
  if (!sessionId) {
    console.error("Usage: piew status <session-id>");
    process.exit(1);
  }
  await statusCommand(sessionId);
} else if (command === "prune") {
  await pruneCommand();
} else if (command === "restart") {
  await restartCommand();
} else {
  // All non-flag arguments are file paths, except the value --timeout takes.
  const files = argv.filter((a, i) => !a.startsWith("-") && argv[i - 1] !== "--timeout");
  const sessionId = await openCommand(files);
  if (wait) await pollCommand(sessionId, { timeoutSecs: timeoutFrom(argv) });
}
