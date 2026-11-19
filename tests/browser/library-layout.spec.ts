import { test, expect } from '@playwright/test';
test('horizontal library cards keep artwork beside metadata across different title lengths', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: { id: 'layout-user', displayName: 'Layout check', isAdmin: false } } }));
  await page.route('**/api/podcasts', route => route.fulfill({ json: { podcasts: ['The Delta Flyers', 'Designed in California (Special Edition) — Private podcast archive', 'Hello Internet'].map((title, i) => ({ id: String(i), title, isSample: false, artworkUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#315a45"/></svg>'), upcoming: 100 + i, delivered: i, status: 'Active', nextSlot: '2026-11-01T16:00:00Z', timeZone: 'America/Chicago', nextEpisode: { id: 'next', title: i === 1 ? 'An episode with a longer title that wraps over several lines' : 'The next episode', episodeNumber: String(42 + i) } })) } }));
  await page.setViewportSize({ width: 1640, height: 1100 });
  await page.goto('/'); await expect(page.locator('.podcast-card')).toHaveCount(3);
  for (const card of await page.locator('.podcast-card').all()) {
    const title = (await card.locator('h2').boundingBox())!;
    const artwork = (await card.locator('.cover').boundingBox())!;
    const counts = (await card.locator('.podcast-counts').boundingBox())!;
    const release = (await card.locator('.next-release').boundingBox())!;
    expect(artwork.x).toBeGreaterThan(title.x + title.width);
    expect(counts.y).toBeGreaterThanOrEqual(title.y + title.height);
    expect(release.y).toBeGreaterThanOrEqual(counts.y + counts.height);
  }
  await expect(page.locator('.library-summary')).toContainText('303 upcoming');
  await expect(page.locator('.library-summary')).toContainText('3 delivered');
  await expect(page.locator('.stats')).toHaveCount(0);
  await expect(page.locator('.next-release strong').first()).toHaveText('Sun, Nov 1, 2026, 10:00 AM');
  await expect(page.locator('.next-episode').first()).toHaveText('Episode 42 · The next episode');
  await expect(page.locator('.next-episode')).toHaveCount(3);
  await page.screenshot({ path: '.local/browser-tests/library-alignment.png', fullPage: true });
  let previousWidth = 0;
  for (const width of [1024, 1280, 1440, 1640, 1920, 2560, 3200]) {
    await page.setViewportSize({ width, height: 1100 });
    const content = (await page.locator('.page-heading').boundingBox())!;
    expect(content.width, `content at ${width}px`).toBeGreaterThan(previousWidth);
    previousWidth = content.width;
  }

});
