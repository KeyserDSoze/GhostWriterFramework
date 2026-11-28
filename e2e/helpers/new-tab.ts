import { expect, type BrowserContext } from "@playwright/test";

// What the specs share for a link that the browser opens in another tab: a click with Ctrl, or with the middle button.

interface OpenPage {
  targetId: string;
  url: string;
}

/**
 * Runs `action` (a click that opens a link in another tab), checks that the browser opened one tab and that its address is `address`, and closes the tab. `gesture` says which click it was.
 *
 * The tab is known by the browser's own list of its pages, not by the `page` event of the context: the headless shell that Playwright 1.62 brings (Chromium 151, what CI installs)
 * sometimes opens the tab, loads the page in it, and never lets Playwright finish setting it up, so that the event does not come until the tab is closed, and a wait for it lasts as long as the
 * test (microsoft/playwright#42142, Chromium issue 543471700; the headless shell of Playwright 1.65, Chromium 159, does not show it). The list does not wait for Playwright, and neither does
 * closing a page through it.
 */
export async function expectNewTab(context: BrowserContext, address: RegExp, action: () => Promise<unknown>, gesture: string): Promise<void> {
  const browser = context.browser();
  if (!browser) throw new Error("The context has no browser to ask for its tabs.");
  const session = await browser.newBrowserCDPSession();
  try {
    const pages = async (): Promise<OpenPage[]> => {
      const { targetInfos } = await session.send("Target.getTargets");
      return targetInfos.filter((target) => target.type === "page").map(({ targetId, url }) => ({ targetId, url }));
    };
    const before = new Set((await pages()).map((page) => page.targetId));
    await action();
    let opened: OpenPage[] = [];
    await expect.poll(async () => {
      opened = (await pages()).filter((page) => !before.has(page.targetId));
      return opened.map((page) => page.url);
    }, { message: `the browser opened the page in one new tab (${gesture})`, timeout: 30_000 }).toEqual([expect.stringMatching(address)]);
    for (const page of opened) await session.send("Target.closeTarget", { targetId: page.targetId });
  } finally {
    await session.detach().catch(() => undefined);
  }
}
