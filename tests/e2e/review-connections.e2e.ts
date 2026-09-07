import { expect, test } from "@playwright/test";
import { openDiffSession } from "./helpers";

const MARKDOWN_CHUNK = /\/assets\/MarkdownViewer-[^/]*\.js$/;

test.describe("opening a diff review", () => {
  test("never asks for the markdown bundle", async ({ page, request }) => {
    const session = await openDiffSession(request);
    const requested: string[] = [];
    page.on("request", (req) => requested.push(req.url()));

    await page.goto(`/review/${session.sessionId}`);
    await expect(page.locator("diffs-container [data-line]").first()).toBeVisible();

    expect(requested.filter((url) => MARKDOWN_CHUNK.test(url))).toEqual([]);
  });

  test("reads the session once for a comment it just posted", async ({ page, request }) => {
    const session = await openDiffSession(request);
    await page.goto(`/review/${session.sessionId}`);
    await expect(page.locator("diffs-container [data-line]").first()).toBeVisible();

    const reads: string[] = [];
    page.on("request", (req) => {
      if (
        req.method() === "GET" &&
        new URL(req.url()).pathname === `/api/session/${session.sessionId}`
      ) {
        reads.push(req.url());
      }
    });

    await page.keyboard.press("c");
    await page.getByPlaceholder("Leave a comment").fill("one read is enough");
    await page.getByRole("button", { name: "Add comment" }).click();
    await expect(page.getByRole("button", { name: "Send to agent" })).toBeEnabled();
    await page.waitForTimeout(500);

    expect(reads).toHaveLength(1);
  });
});

test.describe("a review tab going to the background", () => {
  test("hands the event stream back and takes a fresh one on return", async ({ page, request }) => {
    const session = await openDiffSession(request);
    const opened: string[] = [];
    const settled: string[] = [];
    const isStream = (url: string) => url.includes(`/events?session=${session.sessionId}`);
    page.on("request", (req) => isStream(req.url()) && opened.push(req.url()));
    page.on("requestfinished", (req) => isStream(req.url()) && settled.push(req.url()));
    page.on("requestfailed", (req) => isStream(req.url()) && settled.push(req.url()));

    await page.goto(`/review/${session.sessionId}`);
    await expect(page.locator("diffs-container [data-line]").first()).toBeVisible();
    await expect.poll(() => opened.length).toBe(1);
    expect(settled).toEqual([]);

    await setHidden(page, true);
    await expect.poll(() => settled.length).toBe(1);

    await setHidden(page, false);
    await expect.poll(() => opened.length).toBe(2);
  });

  test("keeps an unsent comment across the reconnect", async ({ page, request }) => {
    const session = await openDiffSession(request);
    await page.goto(`/review/${session.sessionId}`);
    await expect(page.locator("diffs-container [data-line]").first()).toBeVisible();

    await page.keyboard.press("c");
    await page.getByPlaceholder("Leave a comment").fill("draft that must survive");

    await setHidden(page, true);
    await setHidden(page, false);

    await expect(page.getByPlaceholder("Leave a comment")).toHaveValue("draft that must survive");
  });
});

async function setHidden(page: import("@playwright/test").Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}
