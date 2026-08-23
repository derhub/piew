import { test } from "@playwright/test";
import { doc, openReview, openSession } from "./helpers";

test("capture paragraph annotation", async ({ page, request }) => {
  const session = await openSession(request);
  await request.post(`/api/page/${session.pageKey}/comment`, {
    data: {
      startLine: 3,
      endLine: 3,
      quote: "First paragraph, the one the composer opens on.",
      feedback: "Tighten this opening and keep the tone direct.",
    },
  });
  await openReview(page, session);
  await doc(page)
    .locator(".annotated-aside:has(.annotation-thread)")
    .screenshot({
      path: "/Users/johnder/.codex/visualizations/2026/08/23/01a02daa-809f-7fc1-bd25-9e61c22fb979/stable-anchor-beside-paragraph.png",
    });
});
