---
name: piew
description: Open a Markdown file, a source file, or a git diff in the browser so the user can comment on specific lines and suggest replacement wording, then send the whole batch back to you. Use after writing or updating any Markdown file the user will read — specs, plans, reports, designs, handoffs — and to have them review a diff or a source file.
---

# piew

Portable review. The user reads your rendered Markdown in a real browser, comments
on any block, suggests replacement wording, and sends the whole batch at once.

Three kinds of page: Markdown documents, plain source files, and git diffs. Every
page is read-only — the user never edits the file, and piew never writes to it.
Everything comes back as line-anchored feedback for you to apply, keeping the
source's own syntax.

## The loop

1. Write or update the Markdown file.
2. Open it for the user. Multiple files open as one session, navigable in the sidebar:

   ```sh
   piew path/to/spec.md
   piew path/to/spec.md path/to/api.md
   ```

   A path that is not `.md` or `.markdown` opens as a syntax-highlighted source
   file with the same commenting affordances:

   ```sh
   piew src/server/auth.ts
   ```

   A git diff opens through its own subcommand. Ranges, bare refs, and the index
   all work:

   ```sh
   piew diff main..feat
   piew diff HEAD~1
   piew diff --staged
   piew diff
   ```

   Open and diff print `Session: s_...` followed by the current Review Map JSON.
   Keep that session ID: every later command uses it, and the map contains the page
   IDs needed to reorganize diff pages.

3. Organize a complex review by replacing its whole Review Map. Paths are shown in
   the supplied order and may have up to five slash-separated segments. A source can
   reuse a page from the printed map or add an absolute local file:

   ```sh
   echo '{
     "title": "Release review",
     "items": [
       {"path": "Web/Auth/login.ts", "source": {"kind": "page", "pageId": "p_123"}},
       {"path": "API/Auth/route.ts", "source": {"kind": "file", "file": "/abs/api/route.ts"}}
     ]
   }' | piew map s_123
   ```

   This is a full, atomic replacement. Include every page the reviewer should keep.
   Missing sources, unsafe or duplicate paths, duplicate pages, and removal of a page
   with unresolved feedback reject the whole update.

4. Wait for feedback. This blocks until they hit Send, or the timeout passes:

   ```sh
   piew poll s_123 --timeout 600
   ```

   `--wait` on the open command does steps 2 and 3 in one process, which is the
   shortest way in and needs no target of its own:

   ```sh
   piew path/to/spec.md --wait --timeout 600
   piew diff main..feat --wait --timeout 600
   ```

   Keep this command in the foreground. Do not end your turn while it is waiting.
   If your shell returns a process or session handle, keep waiting on that handle
   until the command exits. On `{"status":"timeout"}` no feedback has arrived yet —
   run the same poll again to keep waiting. Feedback survives a dead poll, so
   nothing is ever lost.

5. Apply what comes back, then answer it. One entry per annotation you were sent,
   JSON on stdin:

   ```sh
   echo '{
     "note": "Both applied; one question left.",
     "items": [
       {"id": "c_d89834da", "status": "applied", "note": "rewrote the opening"},
       {"id": "e_3c6e11ff", "status": "skipped", "note": "conflicts with the API contract"},
       {"id": "c_11ff3c6e", "status": "question", "note": "which of the two headings?"}
     ]
   }' | piew respond s_123
   ```

   `status` is `applied`, `skipped`, or `question`. The user sees each verdict on
   the annotation itself and in the chat. Answer every item you were given; an id
   you were never sent comes back in `unknown` and is ignored.

   A `question` is the only status that keeps an item live: the user answers it as
   a new comment on the same line, which arrives in your next batch.

6. Wait again. `--ack` clears the batch you just handled:

   ```sh
   piew poll s_123 --ack --timeout 600
   ```

Repeat 4-6 until the user says they are done. One batch covers every page in the
session.

A daemon restart keeps the review: pages, comments, and the transcript come back,
and a diff comes back with the exact bytes that were reviewed rather than whatever
the working tree says now.

Not sure whether feedback is already waiting — say, at the start of a new turn?
This answers instantly without blocking:

```sh
piew status s_123
```

```json
{
  "status": "feedback-waiting",
  "feedback_waiting": true,
  "agent_listening": false,
  "server_running": true,
  "unsent": { "comments": 2, "edits": 1 }
}
```

`unsent` counts what is still sitting in the browser unsent — the user is mid-review.

## What you get

```json
{
  "status": "feedback",
  "pages": [
    {
      "file": "/abs/path/to/spec.md",
      "comments": [
        {
          "id": "c_d89834da",
          "kind": "line_range",
          "startLine": 3,
          "endLine": 3,
          "feedback": "Tighten this opening."
        }
      ],
      "edits": [
        {
          "id": "e_3c6e11ff",
          "startLine": 5,
          "endLine": 5,
          "originalText": "",
          "suggestedText": "Second paragraph, rewritten by the reviewer."
        }
      ]
    }
  ],
  "overall_note": "feedback not tied to any one line",
  "sent_at": "2026-08-19T08:45:33.229Z"
}
```

`status` is `feedback`, `timeout`, or `closed`. `edits` is omitted when there are none.

## Rules

- **`startLine` is the anchor.** It is a 1-based line in the file named by `file`.
  Both comments and edits carry it; use it to find what they meant.
- **On a diff, `side` says which file the line belongs to.** `"new"` means
  `startLine` indexes the post-image file — apply it directly. `"old"` means the
  line only exists before the change; those are comments about what was removed,
  never edits. Suggested edits are never emitted on the old side.
- **`file` on a diff annotation is repo-relative.** A rename reports the old side
  against the pre-image path and the new side against the post-image path, so one
  renamed file can appear as two entries in `pages`.
- **`suggestedText` is the user's exact replacement wording.** Apply it verbatim —
  do not paraphrase it or fold it into your own phrasing.
- **`originalText` is often empty.** It is only filled when the user selected text
  before suggesting; from the block gutter it comes back `""`. Anchor on `startLine`,
  not on matching `originalText`.
- `quote` appears on comments only when the user selected text; that exact string is
  in the rendered output, so it may differ from the source where inline syntax is
  involved (`**bold**` renders as `bold`).
- `kind` is `line_range` (the whole block), `selection` (they highlighted text), or
  `general`.
- Fix every file in `pages`, not just the first.
- **Answer with `piew respond`, not in the terminal.** The user is reading the
  browser; a verdict typed anywhere else never reaches them. Saving the file still
  reloads the page on its own, so the two together show both what changed and why.
