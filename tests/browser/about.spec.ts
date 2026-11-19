import { test, expect } from '@playwright/test';
test('About is public and navigation lives in the header without a sidebar', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null } }));
  await page.goto('/#about');
  await expect(page.getByRole('heading', { name: 'About RegSched' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Local version' })).toBeVisible();
  await expect(page.locator('header nav a[aria-current="page"]')).toHaveText('About');
  await expect(page.locator('aside')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '.local/browser-tests/about-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/browser-tests/about-mobile.png', fullPage: true });
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
});
