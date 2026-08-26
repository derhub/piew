import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("Review Map keeps a complex live review oriented", async ({ page, request }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piew-map-e2e-"));
  const first = path.join(root, "web", "fixture.md");
  const second = path.join(root, "api", "second.ts");
  const third = path.join(root, "worker", "third.ts");
  for (const file of [first, second, third]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(first, `# Review fixture\n\n${"Long review content.\n\n".repeat(80)}`);
  fs.writeFileSync(second, "export const second = true;\n");
  fs.writeFileSync(third, "export const third = true;\n");

  const created = await request.post("/api/session", { data: { files: [first] } });
  const session = await created.json();
  const firstPageId = session.activePageId;
  await request.put(`/api/session/${session.sessionId}/map`, {
    data: {
      title: "Release review",
      items: [
        { path: "Web/Auth/Login/fixture.md", source: { kind: "page", pageId: firstPageId } },
        { path: "API/Billing/Handlers/second.ts", source: { kind: "file", file: second } },
      ],
    },
  });

  await page.goto(`/review/${session.sessionId}`);
  await expect(page.getByRole("heading", { name: "Review fixture" })).toBeVisible();
  await expect(page.getByText("Release review", { exact: true })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Web", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  await expect(page.getByRole("treeitem", { name: "API", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  await expect(page.getByRole("treeitem", { name: "fixture.md", exact: true })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "second.ts", exact: true })).toBeHidden();
  await expect(page.getByTitle("Web/Auth/Login/fixture.md")).toBeVisible();

  const webTop = (await page.getByRole("treeitem", { name: "Web", exact: true }).boundingBox())!.y;
  const apiTop = (await page.getByRole("treeitem", { name: "API", exact: true }).boundingBox())!.y;
  expect(webTop).toBeLessThan(apiTop);

  await request.post(`/api/session/${session.sessionId}/page/${firstPageId}/comment`, {
    data: { startLine: 3, feedback: "Keep this focused" },
  });
  await expect(page.getByTitle("1 annotation(s)")).toBeVisible();

  await page.getByLabel("Search files").click();
  const search = page.getByRole("textbox", { name: "Search…" });
  const activeLeaf = page.getByRole("treeitem", { name: "fixture.md", exact: true });
  await search.fill("fixture");
  await expect(activeLeaf).toHaveAttribute("aria-selected", "true");

  const content = page.locator("#content");
  await content.evaluate((element) => {
    element.scrollTop = 700;
  });
  const beforeScroll = await content.evaluate((element) => element.scrollTop);
  await request.put(`/api/session/${session.sessionId}/map`, {
    data: {
      title: "Release review",
      items: [
        { path: "Web/Auth/Login/fixture.md", source: { kind: "page", pageId: firstPageId } },
        { path: "API/Billing/Handlers/second.ts", source: { kind: "file", file: second } },
        { path: "Worker/Queue/Jobs/third.ts", source: { kind: "file", file: third } },
      ],
    },
  });

  await expect(page.getByLabel("3 documents")).toBeVisible();
  await expect(search).toHaveValue("fixture");
  await expect(search).toBeFocused();
  await expect(activeLeaf).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Close search").click();
  await expect(activeLeaf).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "second.ts", exact: true })).toBeHidden();
  await expect(page.getByTitle("Web/Auth/Login/fixture.md")).toBeVisible();
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(beforeScroll);
});
