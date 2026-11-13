import { chromium, type BrowserContext, type Page } from 'playwright';
import { z } from 'zod';
import { webUrl } from './contracts.ts';
import type { BrowserEffect } from './execution-policy.ts';

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
export type BrowserEvidence = { message: string; data?: { kind: 'text' | 'image'; bytes: Buffer }; url?: string; title?: string; text?: string; reviewReached?: boolean };

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
          args: this.options.headless ? [] : ['--start-minimized'],
        viewport: { width: 1100, height: 800 }, timeout: 12_000,
      });
      try {
        const context = await this.opening;
        if (this.context !== context) {
          this.context = context;
          this.activePage = context.pages().filter(page => /^https?:/i.test(page.url())).at(-1) ?? context.pages()[0];
          context.on('close', () => { this.context = undefined; this.activePage = undefined; });
        }
      } catch {
        throw new Error('Could not open the Rove browser. Install Microsoft Edge and close any other Rove browser using this profile.');
      } finally { this.opening = undefined; }
    }
    const pages = this.context.pages().filter(page => !page.isClosed());
    const visible = await Promise.all(pages.filter(page => /^https?:/i.test(page.url())).map(async page => ({
      page, visible: await page.evaluate(() => document.visibilityState === 'visible').catch(() => false),
    })));
    this.activePage = visible.find(item => item.visible)?.page
      ?? (this.activePage && !this.activePage.isClosed() && /^https?:/i.test(this.activePage.url()) ? this.activePage : undefined)
      ?? pages.filter(page => /^https?:/i.test(page.url())).at(-1) ?? pages[0] ?? await this.context.newPage();
    return this.activePage;
  }

  private async reviewPage(page: Page) {
    const headings = await page.locator('h1,h2,[role=heading]').allTextContents();
    return /(?:^|[\/._-])review(?:[\/._?#-]|$)/i.test(new URL(page.url()).pathname)
      || headings.some(text => /^(?:review(?: (?:your|the))?\b|order summary|confirm (?:your )?details|check (?:your )?details)/i.test(text.trim()));
  }

  async open() {
    const page = await this.page();
    const connection = await this.context!.newCDPSession(page);
    try {
      const { windowId } = await connection.send('Browser.getWindowForTarget');
      await connection.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await page.bringToFront();
    } finally { await connection.detach(); }
  }
  async close() { await (this.context ?? await this.opening?.catch(() => undefined))?.close(); }

  location() {
    const url = this.activePage?.url();
    if (!url || !/^https?:\/\//i.test(url)) return undefined;
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  }

  async execute(action: BrowserAction, value: unknown, signal: AbortSignal,
    authorize: (effect: BrowserEffect) => Promise<void> = async effect => {
      if (!['navigation', 'edit'].includes(effect.effect)) throw new Error('This page action requires task authorization.');
    }): Promise<BrowserEvidence> {
    const page = await this.page();
    signal.throwIfAborted();
    if (action === 'navigate') {
      const input = browserActions.navigate.parse(value);
      if (/^https?:/i.test(page.url())) await authorize({
        effect: 'navigation', label: 'Navigate', origin: new URL(page.url()).origin, destination: input.url, review: await this.reviewPage(page),
      });
      signal.throwIfAborted();
      const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      if (!response || !response.ok()) throw new Error(response ? `Page returned HTTP ${response.status()}.` : 'No HTTP response was observed.');
      await verify(page, input.expect);
      return { message: 'Page loaded.', reviewReached: await this.reviewPage(page), url: this.location(), title: (await page.title()).slice(0, 200) };
    }
    if (!/^https?:\/\//i.test(page.url())) throw new Error('Navigate to a web page in the Rove browser first.');
    if (action === 'inspect') {
      const { target } = browserActions.inspect.parse(value);
      const region = target ? locate(page, target) : page.locator('body');
      if (target) await region.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {
        throw new Error(`The requested ${target.role ?? target.by} “${target.name}” was not found. Use the observed page content instead of repeating this target.`);
      });
      const text = await region.evaluate(root => {
        const visible = (item: Element) => item.getClientRects().length > 0 && getComputedStyle(item).visibility === 'visible';
        const controls = Array.from(root.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab]'))
          .filter(visible).slice(0, 80).map(item => {
            const field = item as HTMLInputElement;
            const label = item.getAttribute('aria-label') || Array.from(field.labels ?? []).map(label => label.innerText).join(' ')
              || item.getAttribute('placeholder') || (item as HTMLElement).innerText || '';
            return { tag: item.tagName.toLowerCase(), role: item.getAttribute('role'), label: label.trim().slice(0, 160) };
          });
        const headings = Array.from(root.querySelectorAll('h1,h2,h3,[role=heading]')).filter(visible)
          .slice(0, 16).map(item => ({ level: item.tagName.toLowerCase(), text: (item as HTMLElement).innerText.trim().slice(0, 180) }));
        if (root.matches('h1,h2,h3,[role=heading]')) headings.unshift({ level: root.tagName.toLowerCase(), text: (root as HTMLElement).innerText.trim().slice(0, 180) });
        return JSON.stringify({ text: (root as HTMLElement).innerText.slice(0, 36_000), headings, controls });
      }, undefined, { timeout: 5000 });
      const { text: body, headings, controls } = JSON.parse(text);
      return { message: 'Inspected visible page content.', reviewReached: await this.reviewPage(page), url: this.location(), title: (await page.title()).slice(0, 200),
        text: JSON.stringify({ text: body.slice(0, 850), headings, controls: controls.slice(0, 16) }),
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
        if (sensitive) throw new Error('This field requires manual entry. Ask the user to use the Rove browser.');
        await authorize({ effect: 'edit', label: input.target.name, origin: new URL(page.url()).origin, review: await this.reviewPage(page) });
        originMatches(page, input.origin);
        signal.throwIfAborted();
        await element.fill(valueToFill, { timeout: 5000 });
        if (await element.inputValue() !== valueToFill) throw new Error('The field did not retain the requested value.');
      } else {
        const describe = () => element.evaluate((item, fallback) => {
          const link = item.closest('a[href]') as HTMLAnchorElement | null;
          const button = item as HTMLButtonElement;
          const label = (item.getAttribute('aria-label') || (item as HTMLElement).innerText || fallback).trim().slice(0, 180);
          const destination = link?.href || button.form?.action;
          const final = /\b(submit|send|publish|post|pay|purchase|buy|place order|book|donate|confirm (?:order|booking)|save)\b/i.test(label);
          const destructive = /\b(delete|remove|unsubscribe|cancel (?:order|booking|subscription))\b/i.test(label);
          const preparatory = /^(?:continue|next|back|review|preview|search|find|close|cancel|edit|go)(?:\b|$)/i.test(label);
          const effect = destructive ? 'destructive' : final ? 'submission'
            : link && /^https?:/i.test(link.href) ? 'navigation'
            : preparatory || button.form?.method.toLowerCase() === 'get' ? 'navigation' : 'unknown';
          return { effect, label, destination } as const;
        }, input.target.name);
        const observed = await describe();
        await authorize({ ...observed, origin: new URL(page.url()).origin, review: await this.reviewPage(page) });
        originMatches(page, input.origin);
        if (JSON.stringify(await describe()) !== JSON.stringify(observed)) throw new Error('The control changed while awaiting authorization. Inspect the page again.');
        signal.throwIfAborted();
        let popup: Page | undefined;
        const opened = (page: Page) => { popup = page; };
        page.on('popup', opened);
        try {
          await element.click({ timeout: 5000 });
          if (popup) {
            await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
            if (/^https?:/i.test(popup.url())) this.activePage = popup;
          }
        } finally { page.removeListener('popup', opened); }
      }
    } finally { await element.dispose().catch(() => {}); }
    await verify(this.activePage ?? page, input.expect);
    return { message: valueToFill !== undefined ? 'Field value verified.' : input.expect ? 'Clicked and checked the expected page state.' : 'Click dispatched. Inspect or check its effect.', reviewReached: await this.reviewPage(this.activePage ?? page), url: this.location() };
  }
}
