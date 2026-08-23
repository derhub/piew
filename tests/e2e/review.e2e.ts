import { test, expect } from "@playwright/test";
import {
  addComment,
  chat,
  doc,
  openReview,
  openSession,
  panelWidth,
  respond,
  send,
} from "./helpers";

test.describe("keyboard", () => {
  test("? opens the shortcut sheet and Escape closes it", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    await page.keyboard.press("?");
    await expect(page.getByText("Keyboard shortcuts")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByText("Keyboard shortcuts")).toBeHidden();
  });

  test("c opens a comment composer and e opens the edit one", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    await page.keyboard.press("c");
    await expect(page.getByPlaceholder("Leave a comment")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByPlaceholder("Leave a comment")).toBeHidden();

    await page.keyboard.press("e");
    await expect(page.getByPlaceholder("Suggested replacement")).toBeVisible();
  });

  test("keys stay out of the composer while it has focus", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    await page.keyboard.press("c");
    await page.getByPlaceholder("Leave a comment").fill("effect");

    await expect(page.getByPlaceholder("Leave a comment")).toHaveValue("effect");
    await expect(page.getByText("Keyboard shortcuts")).toBeHidden();
  });

  test("/ finds a word and scrolls it into view", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    await page.keyboard.press("/");
    await page.getByLabel("Find in this page").fill("beacon");

    await expect(page.getByText("1/1")).toBeVisible();
    await expect(page.getByText("A line holding the word beacon")).toBeInViewport();
  });

  test("j walks to an annotation", async ({ page, request }) => {
    const session = await openSession(request);
    await addComment(request, session, { startLine: 16, feedback: "the closing line" });
    await openReview(page, session);

    await page.keyboard.press("j");
    await expect(doc(page).getByText("the closing line")).toBeInViewport();
  });

  test("f hides the feedback panel and brings it back", async ({ page, request }) => {
    await openReview(page, await openSession(request));
    const send = page.getByRole("button", { name: "Send to agent" });

    await expect(send).toBeVisible();
    await page.keyboard.press("f");
    await expect(send).toBeHidden();

    // The regression this covers: expand() restores the last size, which after a
    // collapse is zero, so the panel used to stay shut for good.
    await page.keyboard.press("f");
    await expect(send).toBeVisible();
  });

  test("the explorer toggle survives a round trip too", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    expect(await panelWidth(page, "explorer")).toBeGreaterThan(100);

    await page.getByRole("button", { name: "Hide explorer" }).click();
    await expect.poll(() => panelWidth(page, "explorer")).toBe(0);

    await page.getByRole("button", { name: "Show explorer" }).click();
    await expect.poll(() => panelWidth(page, "explorer")).toBeGreaterThan(100);
  });
});

test.describe("outline", () => {
  test("marks the section in view, and follows the scroll", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    const first = page.getByRole("button", { name: "Review fixture" });
    const second = page.getByRole("button", { name: "Second section" });

    await expect(first).toHaveAttribute("aria-current", "location");
    await expect(second).not.toHaveAttribute("aria-current", "location");

    // Scrolled from script, on the panel that actually scrolls: a wheel over the
    // page hides the bug, because the outline used to hear only window scrolls.
    await page.locator("#content > *").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    await expect(second).toHaveAttribute("aria-current", "location");
    await expect(first).not.toHaveAttribute("aria-current", "location");
  });

  test("clicking a row scrolls to that heading", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    await page.getByRole("button", { name: "Second section" }).click();

    await expect(doc(page).getByRole("heading", { name: "Second section" })).toBeInViewport();
  });
});

test.describe("diagram lightbox", () => {
  test("Escape closes it", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    await page.getByRole("button", { name: "Expand diagram" }).click();
    await expect(page.locator("dialog[open]")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  });

  test("page shortcuts stay quiet while it is open", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    await page.getByRole("button", { name: "Expand diagram" }).click();
    await expect(page.locator("dialog[open]")).toBeVisible();

    await page.keyboard.press("c");
    await expect(page.getByPlaceholder("Leave a comment")).toBeHidden();
  });
});

test.describe("markdown rendering", () => {
  test("details sections expand from their summary", async ({ page, request }) => {
    const session = await openSession(
      request,
      `# Review fixture\n\n<details>\n<summary>More context</summary>\n\nHidden **Markdown**.\n</details>`
    );
    await openReview(page, session);

    const details = doc(page).locator("details");
    await expect(details).toHaveCount(1);
    await expect(details.getByText("Hidden Markdown.")).toBeHidden();

    await details.getByText("More context").click();

    await expect(details.getByText("Hidden Markdown.")).toBeVisible();
    await expect(details.locator("strong")).toHaveText("Markdown");
  });
});

test.describe("agent replies", () => {
  test("a paragraph annotation sits beside its paragraph", async ({ page, request }) => {
    const session = await openSession(request);
    await addComment(request, session, { startLine: 3, feedback: "tighten this" });
    await openReview(page, session);

    const row = doc(page).locator(".annotated-aside:has(.annotation-thread)");
    await expect(row).toHaveCSS("display", "grid");
    const paragraph = await row.locator(":scope > p").boundingBox();
    const annotation = await row.locator("[data-annot-id]").boundingBox();

    expect(annotation!.x).toBeGreaterThan(paragraph!.x + paragraph!.width);
  });

  test("double-clicking an unsent annotation opens its editor", async ({ page, request }) => {
    const session = await openSession(request);
    await addComment(request, session, { startLine: 3, feedback: "tighten this" });
    await openReview(page, session);

    await doc(page).getByText("tighten this", { exact: true }).dblclick();

    await expect(doc(page).locator("textarea")).toHaveValue("tighten this");
  });

  test("a verdict lands on the annotation and in the transcript", async ({ page, request }) => {
    const session = await openSession(request);
    const id = await addComment(request, session, { startLine: 3, feedback: "tighten this" });
    await send(request, session);
    await openReview(page, session);

    await respond(request, session, {
      note: "Done with one question left.",
      items: [{ id, status: "applied", note: "rewrote the opening" }],
    });

    await expect(doc(page).getByText("Agent: rewrote the opening")).toBeVisible();
    await expect(doc(page).getByText("applied")).toBeVisible();
    await expect(chat(page).getByText("Done with one question left.")).toBeVisible();
  });

  test("r jumps to the open question and opens a reply", async ({ page, request }) => {
    const session = await openSession(request);
    const id = await addComment(request, session, { startLine: 16, feedback: "which one?" });
    await send(request, session);
    await respond(request, session, {
      items: [{ id, status: "question", note: "section 2 or 3?" }],
    });
    await openReview(page, session);

    await page.keyboard.press("r");
    await expect(doc(page).getByText("Agent: section 2 or 3?")).toBeInViewport();
    await expect(page.getByPlaceholder("Leave a comment")).toBeVisible();
  });

  test("an answered item is frozen but the answer rides the next batch", async ({
    page,
    request,
  }) => {
    const session = await openSession(request);
    const id = await addComment(request, session, { startLine: 3, feedback: "which one?" });
    await send(request, session);
    await respond(request, session, { items: [{ id, status: "question", note: "this one?" }] });
    await openReview(page, session);

    await expect(page.getByRole("button", { name: "Edit annotation" })).toHaveCount(0);

    await page.keyboard.press("r");
    await page.getByPlaceholder("Leave a comment").fill("the second one");
    await page.getByRole("button", { name: "Add comment" }).click();

    await expect(page.getByText("1 pending.")).toBeVisible();
  });
});

test.describe("chat width", () => {
  test("a note fills the panel instead of stopping at a fixed share of it", async ({
    page,
    request,
  }) => {
    const session = await openSession(request);
    await addComment(request, session, { startLine: 3, feedback: "tighten this" });
    await send(request, session, "A note long enough to want every pixel the panel can give it.");
    await openReview(page, session);

    const note = chat(page).getByText("A note long enough to want");
    const panel = await panelWidth(page, "feedback");
    const bubble = (await note.boundingBox())!.width;

    // The bubble primitive caps at 80% for a full-width chat; in a side panel that
    // turns a sentence into a column of single words.
    expect(bubble).toBeGreaterThan(panel * 0.85);
  });

  test("stays inside the panel when the panel is dragged narrow", async ({ page, request }) => {
    const session = await openSession(request);
    await send(request, session, "Another note that has to keep its box inside the panel.");
    await openReview(page, session);

    await page.locator("#feedback").evaluate((el) => {
      el.style.setProperty("width", "220px", "important");
      el.style.setProperty("flex", "0 0 220px", "important");
    });

    const note = chat(page).getByText("Another note that has to keep");
    expect((await note.boundingBox())!.width).toBeLessThanOrEqual(220);
  });
});

test.describe("on this page", () => {
  test("the nav collapses to its icon and comes back", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    const entry = page.getByRole("button", { name: "Second section" });
    await expect(entry).toBeVisible();

    await page.getByLabel("Hide table of contents").click();
    await expect(entry).toBeHidden();

    await page.getByLabel("Show table of contents").click();
    await expect(entry).toBeVisible();
  });

  test("a collapsed nav is still collapsed on the next visit", async ({ page, request }) => {
    const session = await openSession(request);
    await openReview(page, session);

    await page.getByLabel("Hide table of contents").click();
    await page.reload();

    await expect(page.getByLabel("Show table of contents")).toBeVisible();
    await expect(page.getByRole("button", { name: "Second section" })).toBeHidden();
  });
});

test.describe("landing page", () => {
  test("lists an open review and opens it", async ({ page, request }) => {
    const session = await openSession(request);

    await page.goto("/");
    await page
      .getByRole("link", { name: /fixture\.md/ })
      .first()
      .click();

    await expect(page).toHaveURL(new RegExp(session.sessionId));
    await expect(page.getByRole("heading", { name: "Review fixture" })).toBeVisible();
  });
});
