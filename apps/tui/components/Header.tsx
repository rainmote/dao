import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import { qwenTheme } from '../theme.js';

export interface HeaderProps {
  brand?: string;
  version?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  subtitle?: string;
  tip?: string;
  showTips?: boolean;
  terminalWidth?: number;
}

const BB_LOGO = [
  '  ___ ___     _   ___ ___ _  _ _____ ',
  ' | _ ) _ )   /_\\ / __| __| \\| |_   _|',
  ' | _ \\ _ \\  / _ \\ (_ | _|| .` | | |  ',
  ' |___/___/ /_/ \\_\\___|___|_|\\_| |_|  ',
  '                                     ',
  '                                     ',
].join('\n');

const LOGO_WIDTH = 37;
const CONTAINER_MARGIN_X = 2;
const LOGO_GAP = 2;
const PANEL_PADDING_X = 1;
const PANEL_CHROME_WIDTH = 2 + PANEL_PADDING_X * 2;
const MIN_INFO_PANEL_WIDTH = 44;
const MAX_INFO_PANEL_WIDTH = 60;

function versionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

function shortenMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);

  const remaining = maxLength - 1;
  const left = Math.ceil(remaining / 2);
  const right = Math.floor(remaining / 2);
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function tildeifyPath(value: string): string {
  const home = process.env.HOME;
  if (!home || !value.startsWith(home)) return value;
  if (value === home) return '~';
  return value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

export function Header({
  brand = 'bb-agent',
  version,
  provider,
  model,
  cwd,
  subtitle,
  tip = 'Tips: Type / to see all available commands.',
  showTips = true,
  terminalWidth = process.stdout.columns || 80,
}: HeaderProps) {
  const availableWidth = Math.max(1, terminalWidth - CONTAINER_MARGIN_X * 2);
  const showLogo =
    availableWidth >= LOGO_WIDTH + LOGO_GAP + MIN_INFO_PANEL_WIDTH;
  const panelWidth = showLogo
    ? Math.min(availableWidth - LOGO_WIDTH - LOGO_GAP, MAX_INFO_PANEL_WIDTH)
    : availableWidth;
  const contentWidth = Math.max(0, panelWidth - PANEL_CHROME_WIDTH);
  const providerModel = [provider, model].filter(Boolean).join(' | ');
  const modelHint = ' (/model to change)';
  const showModelHint =
    Boolean(model) && providerModel.length + modelHint.length <= contentWidth;
  const displayPath = cwd
    ? shortenMiddle(tildeifyPath(cwd), Math.max(3, contentWidth))
    : ' ';

  return (
    <Box flexDirection="column" width="100%">
      <Box
        flexDirection="row"
        alignItems="center"
        marginX={CONTAINER_MARGIN_X}
        width={availableWidth}
      >
        {showLogo && (
          <>
            <Box width={LOGO_WIDTH} flexShrink={0} justifyContent="center">
              <Gradient colors={[...qwenTheme.ui.gradient]}>
                <Text>{BB_LOGO}</Text>
              </Gradient>
            </Box>
            <Box width={LOGO_GAP} />
          </>
        )}

        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={qwenTheme.border.default}
          paddingX={PANEL_PADDING_X}
          flexGrow={showLogo ? 0 : 1}
          width={showLogo ? panelWidth : undefined}
        >
          <Text wrap="truncate">
            <Text bold color={qwenTheme.text.accent}>{`>_ ${brand}`}</Text>
            {version && (
              <Text color={qwenTheme.text.secondary}>
                {` (${versionLabel(version)})`}
              </Text>
            )}
          </Text>
          <Text color={qwenTheme.text.secondary} wrap="truncate">
            {subtitle || ' '}
          </Text>
          <Text wrap="truncate">
            <Text color={qwenTheme.text.secondary}>{providerModel || ' '}</Text>
            {showModelHint && (
              <Text color={qwenTheme.text.secondary}>{modelHint}</Text>
            )}
          </Text>
          <Text color={qwenTheme.text.secondary} wrap="truncate">
            {displayPath}
          </Text>
        </Box>
      </Box>

      {showTips && tip && (
        <Box marginX={CONTAINER_MARGIN_X}>
          <Text color={qwenTheme.text.secondary} wrap="truncate">
            {tip}
          </Text>
        </Box>
      )}
    </Box>
  );
}
