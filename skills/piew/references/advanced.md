# Advanced Piew operations

## Review Map

Open and diff omit the Review Map from default output. Retrieve it only when the
review needs custom grouping or additional files:

```sh
piew map s_123 --show
```

Replace the complete ordered map with existing page IDs or absolute local files:

```sh
echo '{
  "title": "Release review",
  "items": [
    {"path":"Web/Auth/login.ts","source":{"kind":"page","pageId":"p_123"}},
    {"path":"API/Auth/route.ts","source":{"kind":"file","file":"/abs/api/route.ts"}}
  ]
}' | piew map s_123
```

Paths may contain five safe slash-separated segments. Replacement is atomic.
Missing sources, unsafe or duplicate paths, duplicate pages, and removal of a page
with unresolved feedback reject the whole update.

## Status and recovery

Check a session without blocking:

```sh
piew status s_123
```

`feedback_waiting` means a submitted batch is ready. `unsent` counts comments and
edits still in the browser, so the user is mid-review. `agent_listening` reports an
active poll, and `server_running` distinguishes live state from the disk fallback.

A daemon restart restores pages, comments, the transcript, and the exact diff bytes
that were originally reviewed. Polling an unacknowledged batch returns it again;
`--ack` clears only the batch already delivered to the agent.

## Tool packages

Tools live at `$PIEW_DIR/tools/<name>/`, with `~/.piew/tools/` as the default
registry. `piew tools` reads metadata only. `piew tools <name...> -h` reads direct
agent instructions without starting the daemon or executing package code.

Every package contains:

```text
<name>/
|- tool.json
|- instructions.md
`- Tool.tsx
```

`tool.json` uses this contract:

```json
{
  "schemaVersion": 1,
  "name": "question",
  "description": "Ask the reviewer to choose",
  "when": "A human decision blocks progress",
  "entry": "Tool.tsx",
  "instructions": "instructions.md"
}
```

The directory name must equal `name`. Entry, instruction, and relative asset paths
must stay below the package directory and resolve to regular files. Package source
may import React, React DOM, `@derhub/piew/tool`, and relative files only.

```tsx
import { definePiewTool } from "@derhub/piew/tool";

export default definePiewTool<{ choices: string[] }, string>({
  component({ data, submit }) {
    return data.choices.map((choice) => (
      <button key={choice} onClick={() => submit(choice)}>
        {choice}
      </button>
    ));
  },
});
```

Each invocation compiles an immutable artifact. Editing or deleting the package
does not change an open interaction. The opaque-origin iframe has scripts only; CSP
blocks fetch and subresources, while the sandbox blocks host and top-frame access.
Treat packages as trusted local code because browsers still permit self-navigation.

The host renders the request prompt, tool name, placement, answer, and lifecycle
status. Do not repeat the prompt in the component. Use a labeled `fieldset` for
choices, semantic `button` elements with `type="button"`, visible focus, and a
44-pixel minimum target. Let controls wrap or stack inside the available width;
keep the request and result data contracts unchanged.

## Feedback payload

```json
{
  "status": "feedback",
  "pages": [
    {
      "file": "/abs/path/to/spec.md",
      "comments": [
        {
          "id": "c_1",
          "kind": "line_range",
          "startLine": 3,
          "endLine": 3,
          "feedback": "Tighten this opening."
        }
      ],
      "edits": [
        {
          "id": "e_2",
          "startLine": 5,
          "endLine": 5,
          "originalText": "",
          "suggestedText": "Replacement wording."
        }
      ]
    }
  ],
  "tools": [
    {
      "id": "ti_123",
      "tool": "question",
      "result": { "kind": "submitted", "value": "approve" },
      "replies": []
    }
  ],
  "overall_note": "Feedback not tied to one line."
}
```

`status` is `feedback`, `timeout`, or `closed`. `edits` and an empty
`overall_note` are omitted. `tools` is omitted when empty. A comment `kind` is
`line_range`, `selection`, or `general`.

On renamed diffs, old-side comments use the pre-image path and new-side comments or
edits use the post-image path, so one file may appear as two page entries. Suggested
edits are always on the new side. A selected `quote` is the exact rendered string,
which can omit inline Markdown markers.
