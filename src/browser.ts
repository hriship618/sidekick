import { chromium, type BrowserContext, type Page } from 'playwright';
import { z } from 'zod';
import { webUrl } from './contracts.ts';

const short = z.string().trim().min(1).max(180);
export const targetSchema = z.strictObject({
  by: z.enum(['role', 'label', 'text', 'placeholder']),
  name: short,
  role: z.enum(['button', 'link', 'textbox', 'searchbox', 'heading', 'checkbox', 'radio', 'combobox', 'tab', 'option']).optional(),
});
const expected = z.strictObject({ origin: webUrl, visible: targetSchema.optional() });
export const browserActions = {
  navigate: z.strictObject({ url: webUrl, expect: expected.optional() }),
  inspect: z.strictObject({ target: targetSchema.optional() }),
  click: z.strictObject({ origin: webUrl, target: targetSchema, expect: expected.optional() }),
  fill: z.strictObject({ origin: webUrl, target: targetSchema, value: z.string().max(1000), expect: expected.optional() }),
  screenshot: z.strictObject({}),
};
export const batchSchema = z.strictObject({ actions: z.array(z.discriminatedUnion('action', [
  browserActions.navigate.extend({ action: z.literal('navigate') }),
  browserActions.click.extend({ action: z.literal('click') }),
  browserActions.fill.extend({ action: z.literal('fill') }),
])).min(1).max(5) });

type Target = z.infer<typeof targetSchema>;
type BrowserAction = keyof typeof browserActions;
export type BrowserEvidence = { message: string; data?: { kind: 'text' | 'image'; bytes: Buffer }; url?: string; title?: string; text?: string };

function locate(page: Page, target: Target) {
  const options = { exact: true };
  if (target.by === 'role') {
    if (!target.role) throw new Error('A role locator needs an accessibility role.');
    return page.getByRole(target.role, { ...options, name: target.name });
  }
  if (target.by === 'label') return page.getByLabel(target.name, options);
  if (target.by === 'placeholder') return page.getByPlaceholder(target.name, options);
  return page.getByText(target.name, options);
}

function originMatches(page: Page, expectedUrl: string) {
  if (new URL(page.url()).origin !== new URL(expectedUrl).origin) {
    throw new Error('The page origin changed. Inspect the current page before continuing.');
  }
}

async function verify(page: Page, condition?: z.infer<typeof expected>) {
  if (!condition) return;
  await page.waitForURL(url => url.origin === new URL(condition.origin).origin, { timeout: 5000, waitUntil: 'domcontentloaded' })
    .catch(() => { throw new Error('The expected page origin was not reached.'); });
  if (condition.visible) await locate(page, condition.visible).waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => { throw new Error('The expected page element was not visible.'); });
}

export class BrowserSession {
  private context?: BrowserContext;
  private opening?: Promise<BrowserContext>;
  private activePage?: Page;

  private readonly profile: string;
  private readonly options: { channel?: string; headless?: boolean };

  constructor(profile: string, options: { channel?: string; headless?: boolean } = { channel: 'msedge' }) {
    this.profile = profile;
    this.options = options;
  }

  private async page() {
    if (!this.context) {
      this.opening ??= chromium.launchPersistentContext(this.profile, {
        channel: this.options.channel, headless: this.options.headless ?? false, acceptDownloads: false,
        viewport: { width: 1100, height: 800 }, timeout: 12_000,
      });
      try {
        const context = await this.opening;
        if (this.context !== context) {
          this.context = context;
          this.activePage = context.pages().at(-1);
          context.on('page', page => { this.activePage = page; });
          context.on('close', () => { this.context = undefined; this.activePage = undefined; });
        }
      } catch {
        throw new Error('Could not open the Sidekick browser. Install Microsoft Edge and close any other Sidekick browser using this profile.');
      } finally { this.opening = undefined; }
    }
    if (!this.activePage || this.activePage.isClosed()) this.activePage = this.context.pages().at(-1) ?? await this.context.newPage();
    return this.activePage;
  }

  async open() { await (await this.page()).bringToFront(); }
  async close() { await (this.context ?? await this.opening?.catch(() => undefined))?.close(); }

  location() {
    const url = this.activePage?.url();
    if (!url || !/^https?:\/\//i.test(url)) return undefined;
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  }

  async execute(action: BrowserAction, value: unknown, signal: AbortSignal): Promise<BrowserEvidence> {
    const page = await this.page();
    signal.throwIfAborted();
    if (action === 'navigate') {
      const input = browserActions.navigate.parse(value);
      const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      if (!response || !response.ok()) throw new Error(response ? `Page returned HTTP ${response.status()}.` : 'No HTTP response was observed.');
      await verify(page, input.expect);
      return { message: 'Page loaded.', url: this.location(), title: (await page.title()).slice(0, 200) };
    }
    if (!/^https?:\/\//i.test(page.url())) throw new Error('Navigate to a web page in the Sidekick browser first.');
    if (action === 'inspect') {
      const { target } = browserActions.inspect.parse(value);
      const region = target ? locate(page, target) : page.locator('body');
      const text = await region.evaluate(root => {
        const visible = (item: Element) => item.getClientRects().length > 0 && getComputedStyle(item).visibility === 'visible';
        const controls = Array.from(root.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab]'))
          .filter(visible).slice(0, 80).map(item => {
            const field = item as HTMLInputElement;
            const label = item.getAttribute('aria-label') || Array.from(field.labels ?? []).map(label => label.innerText).join(' ')
              || item.getAttribute('placeholder') || (item as HTMLElement).innerText || '';
            return { tag: item.tagName.toLowerCase(), role: item.getAttribute('role'), label: label.trim().slice(0, 160) };
          });
        return JSON.stringify({ text: (root as HTMLElement).innerText.slice(0, 36_000), controls });
      }, undefined, { timeout: 5000 });
      const { text: body, controls } = JSON.parse(text);
      return { message: 'Inspected visible page content.', url: this.location(), title: (await page.title()).slice(0, 200),
        text: JSON.stringify({ text: body.slice(0, 850), controls: controls.slice(0, 16) }),
        data: { kind: 'text', bytes: Buffer.from(text) } };
    }
    if (action === 'screenshot') {
      const bytes = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000,
        mask: [page.locator('input,textarea,[contenteditable=true]')] });
      return { message: 'Captured the visible viewport. Editable fields are masked.', url: this.location(), data: { kind: 'image', bytes } };
    }
    const input = (action === 'click' ? browserActions.click : browserActions.fill).parse(value);
    originMatches(page, input.origin);
    const locator = locate(page, input.target);
    await locator.waitFor({ state: 'visible', timeout: 5000 });
    // Bind the checked document so navigation cannot re-resolve the locator on a different page.
    const element = await locator.elementHandle({ timeout: 5000 });
    const valueToFill = 'value' in input && typeof input.value === 'string' ? input.value : undefined;
    try {
      originMatches(page, input.origin);
      signal.throwIfAborted();
      if (valueToFill !== undefined) {
        const sensitive = await element.evaluate(item => /password|passwd|credential|secret|one-time|otp|cc-|credit.?card|api.?key|token/i.test(
          ['type', 'autocomplete', 'name', 'id', 'placeholder', 'aria-label'].map(key => item.getAttribute(key) ?? '').join(' ')
          + ' ' + Array.from((item as HTMLInputElement).labels ?? []).map(label => label.textContent ?? '').join(' ')));
        if (sensitive) throw new Error('This field requires manual entry. Ask the user to use the Sidekick browser.');
        originMatches(page, input.origin);
        signal.throwIfAborted();
        await element.fill(valueToFill, { timeout: 5000 });
        if (await element.inputValue() !== valueToFill) throw new Error('The field did not retain the requested value.');
      } else {
        await element.click({ timeout: 5000 });
      }
    } finally { await element.dispose().catch(() => {}); }
    await verify(this.activePage ?? page, input.expect);
    return { message: valueToFill !== undefined ? 'Field value verified.' : input.expect ? 'Clicked and checked the expected page state.' : 'Click dispatched. Inspect or check its effect.', url: this.location() };
  }
}
