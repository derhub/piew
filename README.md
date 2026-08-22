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
bunx piew path/to/spec.md
bunx piew path/to/spec.md path/to/api.md
bunx piew src/server/auth.ts
```

Open a Git diff:

```sh
bunx piew diff main..feature
bunx piew diff --staged
bunx piew diff
```

Wait for a submitted feedback batch:

```sh
bunx piew path/to/spec.md --wait --timeout 600
bunx piew poll path/to/spec.md --timeout 600
```

The full agent workflow and feedback contract live in
[`skills/piew/SKILL.md`](skills/piew/SKILL.md).

## Develop

```sh
bun install
bun run check
```
