import { expect, type Page, type TestInfo } from "@playwright/test";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

/** Each element shows all of its content, sits inside the viewport, and keeps
 * any fitted text inside its own box; the band, clock and bottom bar never overlap. */
export async function expectFits(page: Page, testIds: string[]) {
  const viewport = page.viewportSize()!;
  const boxes: Record<string, Box> = {};
  for (const id of testIds) {
    const element = page.getByTestId(id);
    await expect(element, id).toBeVisible();
    const size = await element.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(size.scrollWidth, `${id} width`).toBeLessThanOrEqual(size.clientWidth + 1);
    expect(size.scrollHeight, `${id} height`).toBeLessThanOrEqual(size.clientHeight + 1);
    const box = await element.boundingBox();
    expect(box, `${id} box`).not.toBeNull();
    if (!box) return;
    expect(box.x, `${id} left`).toBeGreaterThanOrEqual(-1);
    expect(box.y, `${id} top`).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width, `${id} right`).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height, `${id} bottom`).toBeLessThanOrEqual(viewport.height + 1);
    // Fitted text (team numbers, the clock) is scaled down to stay inside its box, never clipped.
    for (const inner of await element.locator(".fit-text__inner").all()) {
      const fitted = await inner.boundingBox();
      expect(fitted, `${id} text box`).not.toBeNull();
      if (!fitted) return;
      expect(fitted.x, `${id} text left`).toBeGreaterThanOrEqual(box.x - 1);
      expect(fitted.y, `${id} text top`).toBeGreaterThanOrEqual(box.y - 1);
      expect(fitted.x + fitted.width, `${id} text right`).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(fitted.y + fitted.height, `${id} text bottom`).toBeLessThanOrEqual(box.y + box.height + 1);
    }
    boxes[id] = box;
  }
  const apart = ["band-red", "band-blue", "clock", "period", "driver-change", "paused", "bottom-bar"].filter((id) => boxes[id]);
  for (let i = 0; i < apart.length; i += 1) {
    for (let j = i + 1; j < apart.length; j += 1) {
      expect(intersects(boxes[apart[i]], boxes[apart[j]]), `${apart[i]} overlaps ${apart[j]}`).toBe(false);
    }
  }
}

/** Saves a screenshot into the test's output folder, for a by-eye check against the mockups. */
export async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}
