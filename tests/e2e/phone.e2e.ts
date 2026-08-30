import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { openReview, openSession, panelWidth } from "./helpers";

async function invokeTool(
  request: Parameters<typeof openSession>[0],
  session: Awaited<ReturnType<typeof openSession>>,
  body: Record<string, unknown>,
  tool = "button"
): Promise<string> {
  const response = await request.post(`/api/session/${session.sessionId}/tool/${tool}`, {
    data: body,
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

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

  test("keeps a general tool within the narrow feedback rail", async ({ page, request }) => {
    const session = await openSession(request);
    const id = await invokeTool(request, session, {
      prompt: "ApproveThisVeryLongUnbrokenReviewerCheckpoint",
      data: {
        label: "ApproveThisVeryLongUnbrokenReviewerAction",
        value: "approve",
      },
    });
    await openReview(page, session);
    await page.getByRole("button", { name: "Show feedback" }).click();

    const tool = page.locator(`[data-tool-id="${id}"]`);
    await expect(tool).toBeVisible();
    const card = await tool.boundingBox();
    expect(card!.x + card!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    const frame = tool.locator("iframe");
    const control = frame
      .contentFrame()
      .getByRole("button", { name: "ApproveThisVeryLongUnbrokenReviewerAction" });
    const controlBox = await control.boundingBox();
    const frameBox = await frame.boundingBox();
    expect(controlBox!.height).toBeGreaterThanOrEqual(44);
    expect(controlBox!.width).toBeGreaterThanOrEqual(44);
    expect(controlBox!.width).toBeLessThanOrEqual(frameBox!.width);
  });

  test("clamps a tall tool and scrolls inside its frame", async ({ page, request }) => {
    const session = await openSession(request);
    const id = await invokeTool(
      request,
      session,
      {
        prompt: "Rate every option",
        data: { min: 1, max: 100 },
      },
      "rating"
    );
    await openReview(page, session);
    await page.getByRole("button", { name: "Show feedback" }).click();

    const frame = page.locator(`[data-tool-id="${id}"] iframe`);
    await expect(frame).toHaveCSS("height", "480px");
    const child = frame.contentFrame();
    await expect
      .poll(() =>
        child.locator("html").evaluate((element) => element.scrollHeight > element.clientHeight)
      )
      .toBeTruthy();
  });

  test("a block can be annotated without a hover", async ({ page, request }) => {
    await openReview(page, await openSession(request));

    const gutter = page.getByRole("button", { name: /^Annotate line/ }).first();
    await expect(gutter).toBeVisible();

    await gutter.click();
    await expect(page.getByPlaceholder("Leave a comment")).toBeVisible();
  });

  test("selecting a Review Map leaf returns to the document", async ({ page, request }) => {
    const session = await openSession(request);
    const second = path.join(path.dirname(session.file), "second.md");
    fs.writeFileSync(second, "# Second review\n\nPhone content.\n");
    await request.put(`/api/session/${session.sessionId}/map`, {
      data: {
        title: "Phone review",
        items: [
          {
            path: "Project/First/fixture.md",
            source: { kind: "page", pageId: session.pageId },
          },
          {
            path: "Project/Second/second.md",
            source: { kind: "file", file: second },
          },
        ],
      },
    });
    await openReview(page, session);

    await page.getByRole("button", { name: "Show explorer" }).click();
    await page.getByRole("treeitem", { name: "Second", exact: true }).click();
    await page.getByRole("treeitem", { name: "second.md", exact: true }).click();

    expect(await panelWidth(page, "explorer")).toBe(0);
    await expect(page.getByRole("heading", { name: "Second review" })).toBeVisible();
  });
});
