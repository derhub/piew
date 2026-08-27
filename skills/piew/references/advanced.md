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
  "overall_note": "Feedback not tied to one line."
}
```

`status` is `feedback`, `timeout`, or `closed`. `edits` and an empty
`overall_note` are omitted. A comment `kind` is `line_range`, `selection`, or
`general`.

On renamed diffs, old-side comments use the pre-image path and new-side comments or
edits use the post-image path, so one file may appear as two page entries. Suggested
edits are always on the new side. A selected `quote` is the exact rendered string,
which can omit inline Markdown markers.
