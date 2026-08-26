import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";

/** Line 3 is the opening paragraph, line 7 holds "beacon", line 16 is the last one. */
export const DOC = `# Review fixture

First paragraph, the one the composer opens on.

## Second section

A line holding the word beacon, which find looks for.

\`\`\`mermaid
flowchart TD
    A["Start"]
    B["End"]
    A --> B
\`\`\`

Closing paragraph.
`;

export interface Session {
  sessionId: string;
  pageId: string;
  file: string;
}

/** A markdown session on a throwaway file, opened the way the CLI opens one. */
export async function openSession(request: APIRequestContext, markdown = DOC): Promise<Session> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-e2e-doc-"));
  const file = path.join(dir, "fixture.md");
  fs.writeFileSync(file, markdown, "utf8");

  const res = await request.post("/api/session", { data: { files: [file] } });
  const body = await res.json();
  return { sessionId: body.sessionId, pageId: body.reviewMap.items[0].pageId, file };
}

export async function addComment(
  request: APIRequestContext,
  session: Session,
  input: { startLine: number; feedback: string }
): Promise<string> {
  const res = await request.post(
    `/api/session/${session.sessionId}/page/${session.pageId}/comment`,
    { data: input }
  );
  const body = await res.json();
  return body.page.comments.at(-1).id as string;
}

export async function send(request: APIRequestContext, session: Session, note?: string) {
  await request.post(`/api/session/${session.sessionId}/send`, { data: { overallNote: note } });
}

export async function respond(
  request: APIRequestContext,
  session: Session,
  body: { note?: string; items: Array<{ id: string; status: string; note?: string }> }
) {
  await request.post(`/api/session/${session.sessionId}/respond`, { data: body });
}

/**
 * How wide a panel is right now. A collapsed panel still holds its markup, and an
 * element clipped to zero width still counts as visible, so width is the honest test.
 */
export async function panelWidth(page: Page, id: "explorer" | "feedback" | "content") {
  // The panel's own element is the group's sizing box; what the reader sees is the
  // child, which on a phone leaves that box behind and covers the document.
  const box = await page.locator(`#${id} > *`).first().boundingBox();
  return Math.round(box?.width ?? 0);
}

/** The review page, waited on until the document itself is rendered. */
export async function openReview(page: Page, session: Session) {
  await page.goto(`/review/${session.sessionId}`);
  await page.getByRole("heading", { name: "Review fixture" }).waitFor();
}

/** The document, so an assertion cannot be satisfied by the chat saying the same thing. */
export const doc = (page: Page) => page.locator("main");
export const chat = (page: Page) => page.locator("#feedback");
