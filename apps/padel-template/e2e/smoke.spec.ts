import { expect, test } from "@playwright/test";

/**
 * Smoke E2E de T0: la app arranca, responde y renderiza el esqueleto.
 *
 * Comprueba tambien que no hay scroll horizontal a 375x667, que es el fallo de
 * layout mas comun en movil y el que la spec prohibe explicitamente.
 */
test("la home carga sin scroll horizontal", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const hasHorizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalScroll).toBe(false);
});
