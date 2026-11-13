import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanionDrag } from '../src/companion-drag.ts';
import { dockedPosition, nearDock, creatureHit } from '../src/companion-geometry.ts';

test('desktop drag retains the grab offset when the overlay moves away from its original viewport', () => {
  const drag = new CompanionDrag({ x: 40, y: 660 }, { x: 64, y: 692 });
  assert.deepEqual(drag.sample({ x: 604, y: 332 }), { x: 580, y: 300 });
  assert.equal(drag.moved, true);
  assert.deepEqual(drag.sample({ x: 1004, y: 692 }), { x: 980, y: 660 });
  const area = { x: 0, y: 0, width: 1280, height: 700 };
  assert.equal(nearDock({ x: 980, y: 660 }, area, 'bottom'), true);
  assert.deepEqual(dockedPosition({ x: 980, y: 660 }, area, 'bottom', true), { x: 980, y: 660 });
});

test('click threshold and negative monitor origins use desktop coordinates, not client coordinates', () => {
  const drag = new CompanionDrag({ x: -1250, y: 800 }, { x: -1226, y: 832 });
  drag.sample({ x: -1224, y: 833 });
  assert.equal(drag.moved, false);
  assert.deepEqual(drag.sample({ x: -700, y: 300 }), { x: -724, y: 268 });
  assert.equal(drag.moved, true);
  drag.sample({ x: -1226, y: 832 });
  assert.equal(drag.moved, true, 'returning to the start remains a drag, not an accidental click');
});

test('visible tucked head pixels can initiate a drag, transparent pixels cannot', () => {
  const head = { x: 900, y: 712 };
  assert.equal(creatureHit({ x: 924, y: 742 }, head), true);
  assert.equal(creatureHit({ x: 920, y: 730 }, head), true);
  assert.equal(creatureHit({ x: 901, y: 713 }, head), false);
  assert.equal(creatureHit({ x: 899, y: 742 }, head), false);
});
