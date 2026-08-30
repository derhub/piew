import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

async function invokeTool(
  request: Parameters<typeof openSession>[0],
  session: Awaited<ReturnType<typeof openSession>>,
  tool: string,
  body: Record<string, unknown>
): Promise<string> {
  const response = await request.post(`/api/session/${session.sessionId}/tool/${tool}`, {
    data: body,
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

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

  test("renders confined native media at desktop and phone widths", async ({ page, request }) => {
    await page.route("https://example.com/**", (route) => route.abort());
    const session = await openSession(
      request,
      `# Review fixture

<figure>
<img src="artifacts/diagram.svg" alt="Local diagram" />
<figcaption>Image caption</figcaption>
</figure>

<figure>
<video controls preload="metadata" poster="artifacts/poster.svg">
<source src="artifacts/demo.mp4" type="video/mp4" />
<track src="artifacts/captions.vtt" kind="captions" srclang="en" label="English" />
<a href="artifacts/demo.mp4">Download video</a>
</video>
<figcaption>Video caption</figcaption>
</figure>

<figure>
<audio controls preload="metadata" src="artifacts/narration.mp3">
<a href="artifacts/narration.mp3">Download audio</a>
</audio>
<figcaption>Audio caption</figcaption>
</figure>

<img src="https://example.com/hosted.svg" alt="Hosted diagram" />
<video data-testid="unsafe-media" controls src="javascript:alert('unsafe')"></video>`
    );
    const artifactsDir = path.join(path.dirname(session.file), "artifacts");
    fs.mkdirSync(artifactsDir);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"></svg>';
    fs.writeFileSync(path.join(artifactsDir, "diagram.svg"), svg, "utf8");
    fs.writeFileSync(path.join(artifactsDir, "poster.svg"), svg, "utf8");
    fs.writeFileSync(path.join(artifactsDir, "demo.mp4"), "video", "utf8");
    fs.writeFileSync(path.join(artifactsDir, "narration.mp3"), "audio", "utf8");
    fs.writeFileSync(
      path.join(artifactsDir, "captions.vtt"),
      "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
      "utf8"
    );
    await openReview(page, session);

    const review = doc(page);
    const image = review.getByAltText("Local diagram");
    const video = review.locator("video").first();
    const source = video.locator("source");
    const track = video.locator("track");
    const audio = review.locator("audio");
    const mediaPath = `/api/session/${session.sessionId}/page/${session.pageId}/media`;
    for (const [element, attribute, relativePath] of [
      [image, "src", "artifacts/diagram.svg"],
      [video, "poster", "artifacts/poster.svg"],
      [source, "src", "artifacts/demo.mp4"],
      [track, "src", "artifacts/captions.vtt"],
      [audio, "src", "artifacts/narration.mp3"],
    ] as const) {
      const url = new URL((await element.getAttribute(attribute))!, page.url());
      expect(url.pathname).toBe(mediaPath);
      expect(url.searchParams.get("path")).toBe(relativePath);
    }

    await expect(review.getByAltText("Hosted diagram")).toHaveAttribute(
      "src",
      "https://example.com/hosted.svg"
    );
    expect((await review.getByTestId("unsafe-media").getAttribute("src")) ?? "").not.toContain(
      "javascript:"
    );
    await expect(video).toHaveAttribute("controls", "");
    await expect(audio).toHaveAttribute("controls", "");
    await expect(track).toHaveAttribute("kind", "captions");
    await expect(review.locator("figcaption")).toHaveText([
      "Image caption",
      "Video caption",
      "Audio caption",
    ]);
    await expect(video.locator("a")).toHaveAttribute("href", "artifacts/demo.mp4");
    await expect(audio.locator("a")).toHaveAttribute("href", "artifacts/narration.mp3");

    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(image).toBeVisible();
      await expect(video).toBeVisible();
      await expect(audio).toBeVisible();
      expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(
        20
      );
      for (const element of [image, video, audio]) {
        const box = await element.boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      }
    }

    const fallbackResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === mediaPath &&
        new URL(response.url()).searchParams.get("path") === "artifacts/demo.mp4",
      { timeout: 1000 }
    );
    await video.locator("a").dispatchEvent("click");
    const response = await fallbackResponse;
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("video/mp4");
  });

  test("inspects markdown images without leaving the review", async ({ page, request }) => {
    const session = await openSession(
      request,
      `# Review fixture

<img src="artifacts/first.svg" alt="First image" />
<img src="artifacts/second.svg" alt="Second image" />

<a href="artifacts/first.svg">Open linked image</a>`
    );
    const artifactsDir = path.join(path.dirname(session.file), "artifacts");
    fs.mkdirSync(artifactsDir);
    const svg = (color: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="${color}" /></svg>`;
    fs.writeFileSync(path.join(artifactsDir, "first.svg"), svg("tomato"), "utf8");
    fs.writeFileSync(path.join(artifactsDir, "second.svg"), svg("royalblue"), "utf8");
    await openReview(page, session);
    await page.evaluate(() => {
      HTMLElement.prototype.requestFullscreen = async function () {
        this.dataset.fullscreenRequested = "true";
      };
    });

    const review = doc(page);
    const first = review.getByAltText("First image");
    const originalUrl = page.url();
    await first.click();

    let viewer = page.locator('dialog[open][aria-label="Image viewer"]');
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText("1 / 2")).toBeVisible();
    await viewer.getByRole("button", { name: "Zoom in" }).click();
    await expect(viewer.getByText("125%")).toBeVisible();

    const viewedImage = viewer.getByAltText("First image");
    const imageBox = await viewedImage.boundingBox();
    await page.mouse.move(imageBox!.x + imageBox!.width / 2, imageBox!.y + imageBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      imageBox!.x + imageBox!.width / 2 + 30,
      imageBox!.y + imageBox!.height / 2 + 20
    );
    await page.mouse.up();
    await expect(viewedImage).not.toHaveAttribute("style", /translate\(0px, 0px\)/);

    await viewer.getByRole("button", { name: "Reset image" }).click();
    await expect(viewer.getByText("100%")).toBeVisible();
    await expect(viewedImage).toHaveAttribute("style", /translate\(0px, 0px\) scale\(1\)/);

    await viewer.getByRole("button", { name: "View fullscreen" }).click();
    await expect(viewer.locator(".image-viewer")).toHaveAttribute(
      "data-fullscreen-requested",
      "true"
    );

    await page.keyboard.press("ArrowRight");
    await expect(viewer.getByAltText("Second image")).toBeVisible();
    await expect(viewer.getByText("2 / 2")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(first).toBeFocused();

    await first.press("Enter");
    viewer = page.locator('dialog[open][aria-label="Image viewer"]');
    await expect(viewer).toBeVisible();
    await viewer.getByRole("button", { name: "Close image viewer" }).click();

    await review.getByRole("link", { name: "Open linked image" }).click();
    viewer = page.locator('dialog[open][aria-label="Image viewer"]');
    await expect(viewer.getByAltText("Open linked image")).toBeVisible();
    expect(page.url()).toBe(originalUrl);

    await page.setViewportSize({ width: 390, height: 844 });
    const viewerBox = await viewer.boundingBox();
    expect(Math.round(viewerBox!.width)).toBe(390);
  });

  test("renders a standalone image in the image viewer", async ({ page, request }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-e2e-image-"));
    const file = path.join(dir, "fixture.svg");
    fs.writeFileSync(
      file,
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="gold" /></svg>',
      "utf8"
    );
    const response = await request.post("/api/session", { data: { files: [file] } });
    const session = await response.json();

    await page.goto(`/review/${session.sessionId}`);

    const viewer = doc(page).getByLabel("Image viewer");
    await expect(viewer.getByAltText("fixture.svg")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Zoom in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Zoom in" })).toHaveCount(1);
    await expect(page.getByLabel("Syntax theme")).toBeHidden();
    await expect(doc(page).locator("diffs-container")).toHaveCount(0);
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

test.describe("agent tools", () => {
  test("renders a general tool and keeps host controls usable", async ({ page, request }) => {
    const session = await openSession(request);
    const id = await invokeTool(request, session, "button", {
      prompt: "Approve this change",
      data: { label: "Approve", value: "approve" },
    });

    await openReview(page, session);
    const tool = page.locator(`[data-tool-id="${id}"]`);
    const frame = tool.locator("iframe");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(tool.getByTestId("tool-status")).toHaveText("open");
    await frame.contentFrame().getByRole("button", { name: "Approve" }).click();
    await expect(tool.getByTestId("tool-status")).toHaveText("ready");

    await tool.getByRole("button", { name: "Reset" }).click();
    await expect(tool.getByTestId("tool-status")).toHaveText("open");
    await tool.getByRole("button", { name: "Dismiss" }).click();
    await expect(tool.getByTestId("tool-status")).toHaveText("ready");
  });

  test("renders an anchored question and accepts a reply after the agent asks", async ({
    page,
    request,
  }) => {
    const session = await openSession(request);
    const id = await invokeTool(request, session, "question", {
      prompt: "Which path should be kept?",
      data: { choices: ["keep", "change"] },
      anchor: { pageId: session.pageId, line: 3 },
    });

    await openReview(page, session);
    const anchored = page.getByTestId("anchored-tools");
    const tool = anchored.locator(`[data-tool-id="${id}"]`);
    await expect(tool).toBeVisible();
    await expect(
      page
        .locator('[data-line-start="3"] + [data-tool-anchor-host]')
        .locator(`[data-tool-id="${id}"]`)
    ).toBeVisible();
    await tool.locator("iframe").contentFrame().getByRole("button", { name: "keep" }).click();
    await expect(tool.getByTestId("tool-status")).toHaveText("ready");

    await send(request, session);
    await respond(request, session, { items: [{ id, status: "question", note: "Keep it?" }] });
    await page.reload();
    await expect(page.getByTestId("tool-status")).toHaveText("awaiting-answer");

    await tool.getByRole("textbox", { name: "Reply to tool" }).fill("Keep it");
    await tool.getByRole("button", { name: "Reply" }).click();
    await expect(tool.getByTestId("tool-status")).toHaveText("ready");

    const fallbackId = await invokeTool(request, session, "button", {
      prompt: "Visible even when the line is absent",
      data: { label: "Continue", value: "continue" },
      anchor: { pageId: session.pageId, line: 999 },
    });
    await expect(page.locator(`[data-tool-id="${fallbackId}"]`)).toBeVisible();
  });
});

test.describe("tool sandbox", () => {
  test("blocks parent, storage, fetch, top navigation, and undeclared assets", async ({
    page,
    request,
  }) => {
    const session = await openSession(request);
    const id = await invokeTool(request, session, "button", {
      prompt: "Inspect the sandbox",
      data: { label: "Continue", value: "continue" },
    });
    await openReview(page, session);

    const frame = page.locator(`[data-tool-id="${id}"] iframe`).contentFrame();
    const result = await frame.locator("body").evaluate(async () => {
      let parentReadable = false;
      let storageWritable = false;
      let networkReachable = false;
      try {
        parentReadable = !!window.parent.document.body;
      } catch {}
      try {
        localStorage.setItem("piew-sandbox", "escaped");
        storageWritable = true;
      } catch {}
      try {
        networkReachable = await fetch("/health").then((response) => response.ok);
      } catch {}
      try {
        window.top!.location.href = "https://example.invalid/escaped";
      } catch {}
      const undeclaredAssetLoaded = await new Promise<boolean>((resolve) => {
        const image = new Image();
        image.addEventListener("load", () => resolve(true), { once: true });
        image.addEventListener("error", () => resolve(false), { once: true });
        image.src = "not-in-manifest.png";
      });
      return { parentReadable, storageWritable, networkReachable, undeclaredAssetLoaded };
    });

    expect(result).toEqual({
      parentReadable: false,
      storageWritable: false,
      networkReachable: false,
      undeclaredAssetLoaded: false,
    });
    expect(page.url()).toContain(`/review/${session.sessionId}`);
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

test.describe("page loading", () => {
  test("shows the server error and retries the page", async ({ page, request }) => {
    const session = await openSession(request);
    let attempts = 0;
    let failPage = true;
    await page.route(
      `**/api/session/${session.sessionId}/page/${session.pageId}`,
      async (route) => {
        attempts += 1;
        if (failPage) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              code: "page-corrupt",
              message: "Stored page is corrupt.",
              retryable: true,
            }),
          });
          return;
        }
        await route.continue();
      }
    );

    await page.goto(`/review/${session.sessionId}`);

    await expect(page.getByRole("alert")).toContainText("Stored page is corrupt.");
    await expect(page.getByText("Loading fixture.md...")).toHaveCount(0);

    const failedAttempts = attempts;
    failPage = false;
    await page.getByRole("button", { name: "Retry" }).click();

    await expect(page.getByRole("heading", { name: "Review fixture" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(attempts).toBeGreaterThan(failedAttempts);
  });

  test("switching pages leaves an aborted request silent", async ({ page, request }) => {
    const session = await openSession(request);
    const second = path.join(path.dirname(session.file), "second.md");
    fs.writeFileSync(second, "# Second review\n\nReady page.\n");
    await request.put(`/api/session/${session.sessionId}/map`, {
      data: {
        title: "Page loading",
        items: [
          { path: "fixture.md", source: { kind: "page", pageId: session.pageId } },
          { path: "second.md", source: { kind: "file", file: second } },
        ],
      },
    });

    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    await page.route(
      `**/api/session/${session.sessionId}/page/${session.pageId}`,
      async (route) => {
        await firstBlocked;
        await route
          .fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              code: "page-corrupt",
              message: "Superseded page failed.",
              retryable: true,
            }),
          })
          .catch(() => undefined);
      }
    );

    await page.goto(`/review/${session.sessionId}`);
    await expect(page.getByText("Loading fixture.md...")).toBeVisible();

    await page.getByRole("treeitem", { name: "second.md", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Second review" })).toBeVisible();
    releaseFirst();

    await expect(page.getByText("Superseded page failed.")).toHaveCount(0);
  });

  test("times out a page request instead of loading forever", async ({ page, request }) => {
    const session = await openSession(request);
    let releaseRequest!: () => void;
    const requestBlocked = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route(
      `**/api/session/${session.sessionId}/page/${session.pageId}`,
      async (route) => {
        await requestBlocked;
        await route.abort().catch(() => undefined);
      }
    );

    await page.goto(`/review/${session.sessionId}`);
    await expect(page.getByText("Loading fixture.md...")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Request timed out", { timeout: 3_000 });
    releaseRequest();
  });
});

test.describe("landing page", () => {
  test("lists an open review and opens it", async ({ page, request }) => {
    const session = await openSession(request);

    await page.goto("/");
    await page
      .getByRole("link", { name: /Review Map/ })
      .first()
      .click();

    await expect(page).toHaveURL(new RegExp(session.sessionId));
    await expect(page.getByRole("heading", { name: "Review fixture" })).toBeVisible();
  });
});
