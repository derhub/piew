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

Install the CLI:

```sh
./install.sh
```

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
piew path/to/spec.md
piew path/to/spec.md path/to/api.md
piew src/server/auth.ts
```

Open a Git diff:

```sh
piew diff main..feature
piew diff --staged
piew diff
```

Wait for a submitted feedback batch:

```sh
piew path/to/spec.md --wait --timeout 600
piew poll path/to/spec.md --timeout 600
```

The full agent workflow and feedback contract live in
[`skills/piew/SKILL.md`](skills/piew/SKILL.md).

## Develop

```sh
bun install
bun run check
```
