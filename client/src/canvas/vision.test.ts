import { expect, it } from 'vitest';
import { createScene, createToken, computeVision } from '@rpg/shared';
import { resolveVision } from './vision';

it('invalidates local vision when token radius changes without movement', () => {
  const scene = createScene({ globalLight: 0, tokens: [createToken({ ownerPlayerId: 'p', visionRadius: 1, x: 700, y: 700 })] });
  scene.fog.mode = 'vision';
  const before = resolveVision(scene, 'PLAYER', 'p');
  scene.tokens[0].visionRadius = 6;
  const after = resolveVision(scene, 'PLAYER', 'p');
  expect(after.visible.size).toBeGreaterThan(before.visible.size);
  expect(after.visible).toEqual(computeVision(scene, { role: 'PLAYER', playerId: 'p' }).visible);
});
