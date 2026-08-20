import { Box } from 'ink';
import { ApprovalDialog, type ApprovalDialogProps } from "./ApprovalDialog";
import {
  SelectionDialog,
  type SelectionDialogProps,
} from "./SelectionDialog";
import {
  TextPromptDialog,
  type TextPromptDialogProps,
} from "./TextPromptDialog";
import { ThemeDialog } from './ThemeDialog.js';

export type ManagedDialog =
  | ({ type: "approval" } & ApprovalDialogProps)
  | ({ type: "selection" } & SelectionDialogProps<string>)
  | ({ type: "input" } & TextPromptDialogProps);

export interface DialogManagerProps {
  dialog?: ManagedDialog | null;
  terminalHeight?: number;
  terminalWidth?: number;
}

export function DialogManager({
  dialog,
  terminalHeight,
  terminalWidth = process.stdout.columns || 80,
}: DialogManagerProps) {
  if (!dialog) return null;
  const dialogWidth = Math.max(1, Math.min(terminalWidth - 4, 100));

  if (dialog.type === "approval") {
    const { type: _type, ...props } = dialog;
    return (
      <Box marginX={2} width={dialogWidth} flexDirection="column">
        <ApprovalDialog
          {...props}
          terminalHeight={props.terminalHeight ?? terminalHeight}
        />
      </Box>
    );
  }

  if (dialog.type === "selection") {
    const { type: _type, ...props } = dialog;
    return (
      <Box marginX={2} width={dialogWidth} flexDirection="column">
        {props.kind === 'theme' ? (
          <ThemeDialog
            {...props}
            terminalHeight={props.terminalHeight ?? terminalHeight}
            terminalWidth={terminalWidth}
          />
        ) : (
          <SelectionDialog
            {...props}
            terminalHeight={props.terminalHeight ?? terminalHeight}
          />
        )}
      </Box>
    );
  }

  const { type: _type, ...props } = dialog;
  return (
    <Box marginX={2} width={dialogWidth} flexDirection="column">
      <TextPromptDialog
        {...props}
        terminalHeight={props.terminalHeight ?? terminalHeight}
        terminalWidth={props.terminalWidth ?? terminalWidth}
      />
    </Box>
  );
}
