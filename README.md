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

Map paths are ordered exactly as supplied and may contain up to five slash-separated
segments. Updating a map is all-or-nothing.

Wait for a submitted feedback batch:

```sh
bunx @derhub/piew path/to/spec.md --wait --timeout 600
bunx @derhub/piew poll s_123 --timeout 600
bunx @derhub/piew status s_123
echo '{"note":"done","items":[{"id":"c_1","status":"applied"}]}' | bunx @derhub/piew respond s_123
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
