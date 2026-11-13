/** Static, local-page-only probe. Includes ancestor opacity: a running DOM can still be invisible. */
export const launcherProbe = `(() => {
  const element = document.querySelector('.command-field,.task-surface,.workspace,.startup-screen');
  if (!element || !element.getClientRects().length) return false;
  for (let node = element; node instanceof Element; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  return true;
})()`;

/** Bound the probe even when a hung renderer never answers executeJavaScript. */
export async function launcherHealthy(probe: () => Promise<unknown>, timeoutMs = 700): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([probe().then(Boolean, () => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}
