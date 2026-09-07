import { expect, test, type Page } from "@playwright/test";
import { openDiffSession } from "./helpers";

test.describe("diff sidebar in the browser", () => {
  test("lists the real directory chain for every changed file", async ({ page, request }) => {
    const session = await openDiffSession(request);
    await page.goto(`/review/${session.sessionId}`);

    const tree = page.locator("#explorer");
    await expect(tree.getByRole("treeitem", { name: session.repoName, exact: true })).toBeVisible();
    await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toBeVisible();
    await expect(tree.getByRole("treeitem", { name: "a", exact: true })).toBeVisible();
    await expect(tree.getByRole("treeitem", { name: /\d-file\.ts/ })).toHaveCount(0);

    await tree.getByRole("treeitem", { name: "b", exact: true }).click();
    await expect(tree.getByRole("treeitem", { name: "x", exact: true })).toHaveCount(2);
  });

  test("shows the real file path in the header breadcrumb", async ({ page, request }) => {
    const session = await openDiffSession(request);
    await page.goto(`/review/${session.sessionId}`);

    await expect(page.locator("#content header")).toContainText("src/a/x/y/z/file.ts");
  });

  test("shows plus and minus counts on each changed file", async ({ page, request }) => {
    const session = await openDiffSession(request, ["src/one.ts", "src/two.ts"]);
    await page.goto(`/review/${session.sessionId}`);

    await expect(page.locator("#explorer").getByText("+20 -20", { exact: true })).toHaveCount(2);
  });

  test("marks the check in the sidebar for a file marked through the api", async ({
    page,
    request,
  }) => {
    const session = await openDiffSession(request, ["src/one.ts", "src/two.ts"]);
    const read = await request.get(`/api/session/${session.sessionId}`);
    const { reviewMap } = await read.json();
    await request.post(
      `/api/session/${session.sessionId}/page/${reviewMap.items[0].pageId}/viewed`,
      { data: { viewed: true } }
    );

    await page.goto(`/review/${session.sessionId}`);
    const check = page.locator("#explorer").getByText("✓", { exact: true });
    await expect(check).toHaveCount(1);

    await page.reload();
    await expect(check).toHaveCount(1);
  });
});

test.describe("marking a diff file viewed", () => {
  const viewedBox = (page: Page) => page.locator("#content header").getByLabel("Viewed");

  test("checks the box and marks the file in the sidebar", async ({ page, request }) => {
    const session = await openDiffSession(request, ["src/one.ts", "src/two.ts"]);
    await page.goto(`/review/${session.sessionId}`);
    const tree = page.locator("#explorer");
    await expect(tree.getByText("✓", { exact: true })).toHaveCount(0);

    await viewedBox(page).click();

    await expect(tree.getByText("✓", { exact: true })).toHaveCount(1);
  });

  test("leaves the file viewed when the box is clicked twice before the server answers", async ({
    page,
    request,
  }) => {
    const session = await openDiffSession(request, ["src/one.ts", "src/two.ts"]);
    await page.goto(`/review/${session.sessionId}`);
    await viewedBox(page).click();
    await page
      .locator("#explorer")
      .getByRole("treeitem", { name: /one\.ts/ })
      .click();
    await expect(viewedBox(page)).toBeChecked();

    await viewedBox(page).evaluate((box: HTMLInputElement) => {
      box.click();
      box.click();
    });

    await expect(page.locator("#explorer").getByText("✓", { exact: true })).toHaveCount(1);
  });

  test("advances to the next unviewed file", async ({ page, request }) => {
    const session = await openDiffSession(request, ["src/one.ts", "src/two.ts"]);
    await page.goto(`/review/${session.sessionId}`);
    await expect(page.locator("#content header")).toContainText("src/one.ts");

    await viewedBox(page).click();

    await expect(page.locator("#content header")).toContainText("src/two.ts");
    await expect(viewedBox(page)).not.toBeChecked();
  });

  test("stays on the last unviewed file", async ({ page, request }) => {
    const session = await openDiffSession(request, ["src/one.ts", "src/two.ts"]);
    await page.goto(`/review/${session.sessionId}`);
    await viewedBox(page).click();
    await expect(page.locator("#content header")).toContainText("src/two.ts");

    await viewedBox(page).click();

    await expect(page.locator("#content header")).toContainText("src/two.ts");
    await expect(viewedBox(page)).toBeChecked();
  });

  test("stays on the file when the box is unchecked", async ({ page, request }) => {
    const session = await openDiffSession(request, ["src/one.ts", "src/two.ts"]);
    await page.goto(`/review/${session.sessionId}`);
    await viewedBox(page).click();
    await expect(page.locator("#content header")).toContainText("src/two.ts");
    await viewedBox(page).click();

    await viewedBox(page).click();

    await expect(page.locator("#content header")).toContainText("src/two.ts");
    await expect(viewedBox(page)).not.toBeChecked();
  });
});
