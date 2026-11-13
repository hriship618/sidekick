import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launcherHealthy } from '../src/launcher-health.ts';
test('launcher probes cannot hang activation and treat renderer failures as unhealthy', async () => {
  assert.equal(await launcherHealthy(async () => true), true);
  assert.equal(await launcherHealthy(async () => false), false);
  assert.equal(await launcherHealthy(async () => { throw new Error('Renderer gone.'); }), false);
  assert.equal(await launcherHealthy(() => { throw new Error('Window already destroyed.'); }), false);
  assert.equal(await launcherHealthy(() => new Promise(() => {}), 10), false);
});
