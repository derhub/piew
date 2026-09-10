# piew

Portable Review.

Sometimes I just want a pretty UI to review what a coding agent made and leave
feedback without worrying about which coding agent I am using. That is why I made
piew.

It opens Markdown, source files, and Git diffs in the browser. I can comment on
exact lines, suggest changes, and send everything back to the agent.

## Requirements

- [Bun](https://bun.sh)
- A local web browser

## Install

No install needed for the CLI — run it with `bunx`.

Install the skill for Claude Code, Codex, and Antigravity with [skills](https://github.com/vercel-labs/skills):

```sh
npx skills add derhub/piew
```

From a local checkout:

```sh
npx skills add ./skills/piew
```

## Use

Telemetry is disabled by default. Start the daemon with `PIEW_TELEMETRY=1` to
enable content-free performance diagnostics in `~/.piew/telemetry.log`
(`$PIEW_DIR/telemetry.log` when configured), retaining a 1 MiB file and one previous
file at `telemetry.log.1`. Every ten seconds it exports queued measurements to an
optional local OTLP collector at `http://127.0.0.1:4318/v1/logs`. Collector outages
do not block review requests; failed exports are counted and are not replayed.
Restart the daemon without this setting to disable local and exported diagnostics.

Diagnostics include request handling time/status, resource counts, memory, uptime,
and maximum observed delay of a one-second timer. Browser samples report navigation,
paint milestones, session resource timing, and supported long tasks. They contain
no document text, paths, URLs, session IDs, or error messages. Request timing ends
when the Response is created; SSE records the handshake and long polls include
their intentional wait. Browser paint milestones are not React render CPU timings.

Open Markdown or source files:

```sh
bunx @derhub/piew path/to/spec.md
bunx @derhub/piew path/to/spec.md path/to/api.md
bunx @derhub/piew src/server/auth.ts
```

Open a Git diff:

```sh
bunx @derhub/piew diff main..feature
bunx @derhub/piew diff --staged
bunx @derhub/piew diff
```

Each open prints compact JSON with the session ID and browser URL. Show the current
Review Map only when the agent needs page IDs for custom organization:

```sh
bunx @derhub/piew map s_123 --show
```

Replace the whole ordered map with existing page IDs or absolute file paths:

```sh
echo '{
  "title": "Release review",
  "items": [
    {"path": "Web/Auth/login.ts", "source": {"kind": "page", "pageId": "p_123"}},
    {"path": "API/Auth/route.ts", "source": {"kind": "file", "file": "/abs/api/route.ts"}}
  ]
}' | bunx @derhub/piew map s_123
```

Map paths are ordered exactly as supplied and may contain up to 32 slash-separated
segments and 512 characters. Updating a map is all-or-nothing.

List the interactive tools available to the agent:

```sh
bunx @derhub/piew tools
bunx @derhub/piew tools question rating button -h
```

Invoke one tool in an existing review session with JSON on stdin:

```sh
echo '{"prompt":"Ship this release?","data":{"choices":["approve","reject"]}}' |
  bunx @derhub/piew tools question s_123
```

Tools live in `$PIEW_DIR/tools/<name>/`, or `~/.piew/tools/<name>/` by default.
The first run seeds `question`, `rating`, and `button`. Each package contains
`tool.json`, direct agent instructions, and a React `Tool.tsx` component. Piew never
overwrites an existing package.

```text
question/
|- tool.json
|- instructions.md
`- Tool.tsx
```

Tool components may import relative package files, React, React DOM, and
`@derhub/piew/tool`. Compilation rejects runtime environment access, macros, dynamic
imports, external URLs, path escapes, and undeclared modules. The browser runs the
compiled artifact in an opaque-origin, script-only iframe; CSP blocks fetch and
subresources, and the sandbox blocks host and top-frame access. Tool packages are
trusted local code: browsers still allow a sandboxed frame to navigate itself, so do
not install packages from untrusted sources.

Wait for a submitted feedback batch:

```sh
bunx @derhub/piew path/to/spec.md --wait --timeout 600
bunx @derhub/piew poll s_123 --timeout 600
bunx @derhub/piew status s_123
echo '{"note":"done","items":[{"id":"c_1","status":"applied"}]}' | bunx @derhub/piew respond s_123
bunx @derhub/piew close s_123
```

The full agent workflow and feedback contract live in
[`skills/piew/SKILL.md`](skills/piew/SKILL.md). Review Map, status, recovery, and
payload details live in
[`skills/piew/references/advanced.md`](skills/piew/references/advanced.md).

## Develop

```sh
bun install
bun run check
```
