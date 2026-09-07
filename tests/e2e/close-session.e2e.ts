import { expect, test } from "@playwright/test";
import { openSession } from "./helpers";

test("closing a session from the home list removes only that row", async ({ page, request }) => {
  const first = await openSession(request);
  const second = await openSession(request);

  await page.goto("/");
  const firstLink = page.locator(`a[href="/review/${first.sessionId}"]`);
  const secondLink = page.locator(`a[href="/review/${second.sessionId}"]`);
  await expect(firstLink).toBeVisible();
  await expect(secondLink).toBeVisible();

  await firstLink.locator("xpath=..").getByRole("button", { name: /close/i }).click();

  await expect(firstLink).toHaveCount(0);
  await expect(secondLink).toBeVisible();

  const res = await request.get(`/api/session/${first.sessionId}`);
  expect(res.status()).toBe(404);
});

test("closing a session while its review page is open shows a closed message without reload", async ({
  page,
  request,
}) => {
  const session = await openSession(request);

  const sseRequest = page.waitForRequest(`/events?session=${session.sessionId}`);
  await page.goto(`/review/${session.sessionId}`);
  await expect(page.getByRole("heading", { name: "Review fixture" })).toBeVisible();
  await sseRequest;

  await request.delete(`/api/session/${session.sessionId}`);

  await expect(page.getByText("Session closed")).toBeVisible({ timeout: 5000 });
});
