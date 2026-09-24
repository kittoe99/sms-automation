import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/e2-theme.css', import.meta.url), 'utf8');
const embedCss = readFileSync(new URL('../public/embed.css', import.meta.url), 'utf8');

function luminance(hex) {
  const values = hex.slice(1).match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

test('CRM and embedded forms use the E2.Local design system with readable colors', () => {
  assert.doesNotMatch(css, /color-scheme:\s*dark/);
  const root = css.match(/:root\s*\{([^}]+)\}/)?.[1];
  assert.ok(root);
  const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)]
    .map(([, name, color]) => [name, color]));
  assert.equal(tokens.brand, '#087aa5');
  assert.equal(tokens.text, '#172f36');
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
  assert.match(embedCss, /--blue:\s*#087aa5/);
  for (const asset of ['e2-logo.svg', 'e2-icon.svg', 'fonts/plus-jakarta-sans-latin.woff2']) {
    assert.ok(existsSync(new URL(`../public/${asset}`, import.meta.url)), asset);
  }
});
