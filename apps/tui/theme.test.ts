import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_THEME_NAME,
  THEME_OPTIONS,
  getActiveTheme,
  getTheme,
  normalizeThemeName,
  qwenTheme,
  setActiveTheme,
} from './theme.js';

test.afterEach(() => {
  setActiveTheme(DEFAULT_THEME_NAME);
});

test('starts with Qwen Code default theme and exact semantic chrome tokens', () => {
  setActiveTheme(DEFAULT_THEME_NAME);
  assert.equal(getActiveTheme().name, 'Qwen Dark');
  assert.equal(qwenTheme.text.accent, '#CBA6F7');
  assert.equal(qwenTheme.border.focused, '#89B4FA');
  assert.deepEqual(qwenTheme.ui.gradient, ['#4796E4', '#847ACE', '#C3677F']);
  assert.equal(qwenTheme.colors.background, '#0b0e14');
  assert.equal(qwenTheme.colors.lightBlue, '#59C2FF');
});

test('updates the stable semantic object when the active theme changes', () => {
  const stableObject = qwenTheme;
  assert.equal(setActiveTheme('Dracula'), 'Dracula');
  assert.equal(qwenTheme, stableObject);
  assert.equal(qwenTheme.text.accent, '#ff79c6');
  assert.equal(qwenTheme.border.focused, '#8be9fd');
  assert.deepEqual(qwenTheme.ui.gradient, ['#ff79c6', '#8be9fd']);
  assert.equal(qwenTheme.colors.background, '#282a36');

  assert.equal(setActiveTheme('Qwen Light'), 'Qwen Light');
  assert.equal(qwenTheme.text.accent, '#8B5CF6');
  assert.equal(qwenTheme.colors.background, '#f8f9fa');
});

test('matches Qwen built-in theme names exactly', () => {
  assert.deepEqual(
    THEME_OPTIONS.map((option) => option.value),
    [
      'auto', 'Qwen Light', 'Qwen Dark', 'ANSI', 'Atom One', 'Ayu',
      'Default', 'Dracula', 'GitHub', 'Shades Of Purple', 'ANSI Light',
      'Ayu Light', 'Default Light', 'GitHub Light', 'Google Code', 'Xcode',
    ],
  );
  assert.equal(normalizeThemeName('Qwen Dark'), 'Qwen Dark');
  assert.equal(normalizeThemeName('Dracula'), 'Dracula');
  assert.equal(normalizeThemeName('qwen dark'), undefined);
  assert.equal(normalizeThemeName('midnight'), undefined);
  assert.equal(normalizeThemeName('paper'), undefined);
  assert.equal(normalizeThemeName('matrix'), undefined);
  assert.equal(getTheme('not-a-theme'), undefined);
});
