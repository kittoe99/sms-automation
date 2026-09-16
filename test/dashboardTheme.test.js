import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function luminance(hex) {
  const values = hex.slice(1).match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

test('dashboard uses a light native theme and readable palette', () => {
  assert.doesNotMatch(css, /color-scheme:\s*dark/);
  const roots = [...css.matchAll(/:root\s*\{([^}]+)\}/g)];
  assert.ok(roots.length);
  for (const [, root] of roots) {
    const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)]
      .map(([, name, color]) => [name, color]));
    assert.equal(tokens.surface, '#ffffff');
    assert.ok(luminance(tokens.bg) > 0.9);
    for (const [foreground, background] of [
      ['text', 'surface'], ['muted', 'surface'], ['muted', 'bg'],
      ['brand', 'surface'], ['ok', 'surface'], ['warn', 'surface'], ['bad', 'surface'], ['info', 'surface'],
    ]) {
      const a = luminance(tokens[foreground]);
      const b = luminance(tokens[background]);
      const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert.ok(contrast >= 4.5, `${foreground} on ${background}: ${contrast.toFixed(2)}`);
    }
  }
});
