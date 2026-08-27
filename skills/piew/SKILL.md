---
name: piew
description: Open Markdown, source files, or git diffs in the browser for line comments and suggested replacements. Use after writing a document the user will review or when line-level feedback is needed.
---

# piew

Piew is a read-only browser review surface. The user comments on rendered files or
diffs, and the CLI returns line-anchored feedback for the agent to apply.

## Review loop

1. Open one or more files, or a git diff:

   ```sh
   piew path/to/spec.md
   piew path/to/spec.md path/to/api.md
   piew src/server/auth.ts
   piew diff main..feat
   piew diff --staged
   piew diff
   ```

   Open and diff print compact JSON containing `sessionId` and `url`. Keep the
   session ID for every later command.

2. Poll until the user sends feedback:

   ```sh
   piew poll s_123 --timeout 600
   ```

   The shortest path opens and waits in one process:

   ```sh
   piew path/to/spec.md --wait --timeout 600
   piew diff main..feat --wait --timeout 600
   ```

   Keep the command in the foreground. If it returns a process handle, keep waiting
   on that handle. `{"status":"timeout"}` means no feedback arrived; run the same
   poll again. Feedback survives a dead poll.

3. Apply every item in every page from the returned batch.

   - `file` names the target. On a diff it is repository-relative.
   - `startLine` is the 1-based anchor for comments and edits.
   - `side: "new"` indexes the post-image and can be changed directly.
   - `side: "old"` describes removed code and never carries a suggested edit.
   - `suggestedText` is the user's exact replacement wording; apply it verbatim.
   - `originalText` may be empty. Anchor on `startLine`, not on text matching.
   - `quote` is rendered text and may differ from source Markdown syntax.

4. Send one verdict for every delivered annotation:

   ```sh
   echo '{
     "note": "Both applied; one question remains.",
     "items": [
       {"id":"c_1","status":"applied","note":"rewrote the opening"},
       {"id":"e_2","status":"skipped","note":"conflicts with the API contract"},
       {"id":"c_3","status":"question","note":"which heading?"}
     ]
   }' | piew respond s_123
   ```

   Status is `applied`, `skipped`, or `question`. Only `question` keeps an item live.
   Always answer with `piew respond`; terminal prose does not reach the browser.

5. Acknowledge the handled batch and wait again:

   ```sh
   piew poll s_123 --ack --timeout 600
   ```

Repeat until the user says the review is done. One batch covers every page in the
session, and saving a reviewed file reloads it in the browser.

Read [references/advanced.md](references/advanced.md) before reorganizing a Review
Map, checking status, recovering a daemon session, or interpreting uncommon payload
fields.
