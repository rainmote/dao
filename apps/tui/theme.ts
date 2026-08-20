export type ThemeType = 'dark' | 'light' | 'ansi';

export interface ThemeColors {
  type: ThemeType;
  background: string;
  foreground: string;
  lightBlue: string;
  accentBlue: string;
  accentPurple: string;
  accentCyan: string;
  accentGreen: string;
  accentYellow: string;
  accentRed: string;
  accentYellowDim: string;
  accentRedDim: string;
  diffAdded: string;
  diffRemoved: string;
  comment: string;
  gray: string;
  gradient: readonly string[];
}

export interface SemanticTheme {
  name: ThemeName;
  type: ThemeType;
  colors: ThemeColors;
  text: {
    primary: string;
    secondary: string;
    link: string;
    accent: string;
    code: string;
  };
  background: {
    primary: string;
    diff: { added: string; removed: string };
  };
  border: { default: string; focused: string };
  ui: {
    comment: string;
    symbol: string;
    gradient: readonly string[];
  };
  status: {
    success: string;
    warning: string;
    error: string;
    warningDim: string;
    errorDim: string;
  };
}

function colors(
  type: ThemeType,
  background: string,
  foreground: string,
  lightBlue: string,
  accentBlue: string,
  accentPurple: string,
  accentCyan: string,
  accentGreen: string,
  accentYellow: string,
  accentRed: string,
  diffAdded: string,
  diffRemoved: string,
  comment: string,
  gray: string,
  gradient: readonly string[],
): ThemeColors {
  return {
    type,
    background,
    foreground,
    lightBlue,
    accentBlue,
    accentPurple,
    accentCyan,
    accentGreen,
    accentYellow,
    accentRed,
    accentYellowDim: type === 'light' ? '#8B7000' : '#8B7530',
    accentRedDim: type === 'light' ? '#993333' : '#8B3A4A',
    diffAdded,
    diffRemoved,
    comment,
    gray,
    gradient,
  };
}

const DEFAULT_DARK_COLORS = colors(
  'dark', '#1E1E2E', '', '#ADD8E6', '#89B4FA', '#CBA6F7', '#89DCEB',
  '#A6E3A1', '#F9E2AF', '#F38BA8', '#28350B', '#430000', '#6C7086',
  '#6C7086', ['#4796E4', '#847ACE', '#C3677F'],
);

const DEFAULT_LIGHT_COLORS = colors(
  'light', '#FAFAFA', '', '#89BDCD', '#3B82F6', '#8B5CF6', '#06B6D4',
  '#3CA84B', '#D5A40A', '#DD4C4C', '#C6EAD8', '#FFCCCC', '#008000',
  '#97a0b0', ['#4796E4', '#847ACE', '#C3677F'],
);

const THEME_COLORS = {
  'Ayu': colors(
    'dark', '#0b0e14', '#aeaca6', '#59C2FF', '#39BAE6', '#D2A6FF',
    '#95E6CB', '#AAD94C', '#FFB454', '#F26D78', '#293022', '#3D1215',
    '#646A71', '#3D4149', ['#FFB454', '#F26D78'],
  ),
  'Ayu Light': colors(
    'light', '#f8f9fa', '#5c6166', '#55b4d4', '#399ee6', '#a37acc',
    '#4cbf99', '#86b300', '#f2ae49', '#f07171', '#C6EAD8', '#FFCCCC',
    '#ABADB1', '#a6aaaf', ['#399ee6', '#86b300'],
  ),
  'Atom One': colors(
    'dark', '#282c34', '#abb2bf', '#61aeee', '#61aeee', '#c678dd',
    '#56b6c2', '#98c379', '#e6c07b', '#e06c75', '#39544E', '#562B2F',
    '#5c6370', '#5c6370', ['#61aeee', '#98c379'],
  ),
  'Dracula': colors(
    'dark', '#282a36', '#a3afb7', '#8be9fd', '#8be9fd', '#ff79c6',
    '#8be9fd', '#50fa7b', '#fff783', '#ff5555', '#11431d', '#6e1818',
    '#6272a4', '#6272a4', ['#ff79c6', '#8be9fd'],
  ),
  'Default Light': DEFAULT_LIGHT_COLORS,
  'Default': DEFAULT_DARK_COLORS,
  'GitHub': colors(
    'dark', '#24292e', '#c0c4c8', '#79B8FF', '#79B8FF', '#B392F0',
    '#9ECBFF', '#85E89D', '#FFAB70', '#F97583', '#3C4636', '#502125',
    '#6A737D', '#6A737D', ['#79B8FF', '#85E89D'],
  ),
  'GitHub Light': colors(
    'light', '#f8f8f8', '#24292E', '#0086b3', '#458', '#900', '#009926',
    '#008080', '#990073', '#d14', '#C6EAD8', '#FFCCCC', '#998', '#999',
    ['#458', '#008080'],
  ),
  'Google Code': colors(
    'light', 'white', '#444', '#066', '#008', '#606', '#066', '#080',
    '#660', '#800', '#C6EAD8', '#FEDEDE', '#5f6368', '#97a0b0',
    ['#066', '#606'],
  ),
  'Qwen Light': colors(
    'light', '#f8f9fa', '#5c6166', '#55b4d4', '#399ee6', '#a37acc',
    '#4cbf99', '#86b300', '#f2ae49', '#f07171', '#86b300', '#f07171',
    '#ABADB1', '#CCCFD3', ['#399ee6', '#86b300'],
  ),
  'Qwen Dark': colors(
    'dark', '#0b0e14', '#bfbdb6', '#59C2FF', '#39BAE6', '#D2A6FF',
    '#95E6CB', '#AAD94C', '#FFD700', '#F26D78', '#AAD94C', '#F26D78',
    '#646A71', '#3D4149', ['#FFD700', '#da7959'],
  ),
  'Shades Of Purple': colors(
    'dark', '#2d2b57', '#e3dfff', '#847ace', '#a599e9', '#ac65ff',
    '#a1feff', '#A5FF90', '#fad000', '#ff628c', '#383E45', '#572244',
    '#B362FF', '#726c86', ['#4d21fc', '#847ace', '#ff628c'],
  ),
  'Xcode': colors(
    'light', '#fff', '#444', '#0E0EFF', '#1c00cf', '#aa0d91', '#3F6E74',
    '#007400', '#836C28', '#c41a16', '#C6EAD8', '#FEDEDE', '#007400',
    '#c0c0c0', ['#1c00cf', '#007400'],
  ),
  'ANSI': colors(
    'dark', 'black', 'white', 'blueBright', 'blue', 'magenta', 'cyan',
    'green', 'yellow', 'red', '#003300', '#4D0000', 'gray', 'gray',
    ['cyan', 'green'],
  ),
  'ANSI Light': colors(
    'light', 'white', '#444', 'blue', 'blue', 'magenta', 'cyan', 'green',
    'yellow', 'red', '#E5F2E5', '#FFE5E5', 'gray', 'gray', ['blue', 'green'],
  ),
} as const satisfies Record<string, ThemeColors>;

export type ThemeName = keyof typeof THEME_COLORS;
export type ThemeSelection = ThemeName | 'auto';

export const DEFAULT_THEME_NAME: ThemeName = 'Qwen Dark';

export const THEME_OPTIONS: readonly {
  value: ThemeSelection;
  label: string;
  type: ThemeType | 'auto';
}[] = [
  { value: 'auto', label: 'Auto (detect terminal theme)', type: 'auto' },
  { value: 'Qwen Light', label: 'Qwen Light', type: 'light' },
  { value: 'Qwen Dark', label: 'Qwen Dark', type: 'dark' },
  { value: 'ANSI', label: 'ANSI', type: 'dark' },
  { value: 'Atom One', label: 'Atom One', type: 'dark' },
  { value: 'Ayu', label: 'Ayu', type: 'dark' },
  { value: 'Default', label: 'Default', type: 'dark' },
  { value: 'Dracula', label: 'Dracula', type: 'dark' },
  { value: 'GitHub', label: 'GitHub', type: 'dark' },
  { value: 'Shades Of Purple', label: 'Shades Of Purple', type: 'dark' },
  { value: 'ANSI Light', label: 'ANSI Light', type: 'light' },
  { value: 'Ayu Light', label: 'Ayu Light', type: 'light' },
  { value: 'Default Light', label: 'Default Light', type: 'light' },
  { value: 'GitHub Light', label: 'GitHub Light', type: 'light' },
  { value: 'Google Code', label: 'Google Code', type: 'light' },
  { value: 'Xcode', label: 'Xcode', type: 'light' },
];

function semantic(name: ThemeName, palette: ThemeColors): SemanticTheme {
  return {
    name,
    type: palette.type,
    colors: palette,
    text: {
      primary: palette.foreground,
      secondary: palette.gray,
      link: palette.accentBlue,
      accent: palette.accentPurple,
      code: palette.lightBlue,
    },
    background: {
      primary: palette.background,
      diff: { added: palette.diffAdded, removed: palette.diffRemoved },
    },
    border: { default: palette.gray, focused: palette.accentBlue },
    ui: {
      comment: palette.comment,
      symbol: palette.gray,
      gradient: palette.gradient,
    },
    status: {
      success: palette.accentGreen,
      warning: palette.accentYellow,
      error: palette.accentRed,
      warningDim: palette.accentYellowDim,
      errorDim: palette.accentRedDim,
    },
  };
}

const THEMES = Object.fromEntries(
  Object.entries(THEME_COLORS).map(([name, palette]) => [
    name,
    semantic(name as ThemeName, palette),
  ]),
) as Record<ThemeName, SemanticTheme>;

// Qwen's branded themes deliberately use the stable default semantic palette
// for chrome while retaining their own syntax/diff colors.
THEMES['Qwen Dark'] = {
  ...semantic('Qwen Dark', DEFAULT_DARK_COLORS),
  colors: THEME_COLORS['Qwen Dark'],
};
THEMES['Qwen Light'] = {
  ...semantic('Qwen Light', DEFAULT_LIGHT_COLORS),
  colors: THEME_COLORS['Qwen Light'],
};
THEMES['ANSI'] = {
  ...semantic('ANSI', DEFAULT_DARK_COLORS),
  colors: THEME_COLORS['ANSI'],
};
THEMES['ANSI Light'] = {
  ...semantic('ANSI Light', DEFAULT_LIGHT_COLORS),
  colors: THEME_COLORS['ANSI Light'],
};

let activeTheme: SemanticTheme = THEMES[DEFAULT_THEME_NAME];

function terminalLooksLight(): boolean {
  const colorFgBg = process.env.COLORFGBG?.split(';').at(-1);
  if (!colorFgBg || !/^\d+$/.test(colorFgBg)) return false;
  return Number(colorFgBg) >= 7;
}

export function normalizeThemeName(value: unknown): ThemeSelection | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'auto') return 'auto';
  return Object.hasOwn(THEMES, trimmed) ? trimmed as ThemeName : undefined;
}

export function setActiveTheme(value: unknown): ThemeSelection | undefined {
  const selection = normalizeThemeName(value);
  if (!selection) return undefined;
  activeTheme = selection === 'auto'
    ? THEMES[terminalLooksLight() ? 'Qwen Light' : 'Qwen Dark']
    : THEMES[selection];
  return selection;
}

export function getActiveTheme(): SemanticTheme {
  return activeTheme;
}

export function getTheme(value: unknown): SemanticTheme | undefined {
  const name = normalizeThemeName(value);
  if (!name) return undefined;
  if (name === 'auto') return THEMES[terminalLooksLight() ? 'Qwen Light' : 'Qwen Dark'];
  return THEMES[name];
}

// Match Qwen Code's semantic-colors module: a stable object whose getters
// always resolve against the active theme. React state changes cause consumers
// to render again and observe the new palette without prop plumbing.
export const qwenTheme: Omit<SemanticTheme, 'name' | 'type'> = {
  get colors() { return activeTheme.colors; },
  get text() { return activeTheme.text; },
  get background() { return activeTheme.background; },
  get border() { return activeTheme.border; },
  get ui() { return activeTheme.ui; },
  get status() { return activeTheme.status; },
};

// VS15 forces ambiguous symbols into their one-column text presentation.
const VS15 = '\uFE0E';

export const QWEN_ICON = {
  diamond: `◆${VS15}`,
  circleFilled: `●${VS15}`,
  triangle: `△${VS15}`,
  therefore: `∴${VS15}`,
  because: `∵${VS15}`,
} as const;
