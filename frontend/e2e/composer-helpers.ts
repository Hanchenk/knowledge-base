import { expect, type Page } from "@playwright/test";

export async function openComposerMore(page: Page) {
  const palette = page.getByRole("dialog", {
    name: "更多功能",
    exact: true,
  });
  if (!(await palette.isVisible())) {
    if (await page.locator(".bot-composer .bot-tool-panel").isVisible())
      await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "更多", exact: true }).click();
  }
  await expect(palette).toBeVisible();
  return palette;
}

export async function openComposerResource(page: Page, name: string) {
  const palette = await openComposerMore(page);
  await palette.getByRole("button", { name, exact: true }).click();
}
