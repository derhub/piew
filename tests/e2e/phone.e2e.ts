import { test, expect } from "@playwright/test";
import { openReview, openSession, panelWidth } from "./helpers";

test.describe("on a phone", () => {
  test("opens on the document alone, with both panels away", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    expect(await panelWidth(page, "explorer")).toBe(0);
    await expect(page.getByRole("button", { name: "Send to agent" })).toBeHidden();

    const doc = page.getByRole("heading", { name: "Review fixture" });
    const width = (await doc.boundingBox())!.width;
    expect(width).toBeGreaterThan(page.viewportSize()!.width * 0.6);
  });

  test("the feedback panel slides over the document", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    await page.getByRole("button", { name: "Show feedback" }).click();
    await expect(page.getByRole("button", { name: "Send to agent" })).toBeVisible();

    // Overlaying, not splitting: the panel covers most of the screen while the
    // document underneath keeps its full width.
    const screen = page.viewportSize()!.width;
    expect(await panelWidth(page, "feedback")).toBeGreaterThan(screen * 0.5);
    expect(await panelWidth(page, "content")).toBeGreaterThanOrEqual(screen - 4);
  });

  test("a block can be annotated without a hover", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    const gutter = page.getByRole("button", { name: /^Annotate line/ }).first();
    await expect(gutter).toBeVisible();

    await gutter.click();
    await expect(page.getByPlaceholder("Leave a comment")).toBeVisible();
  });
});
