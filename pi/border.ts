// Account information occupies spare cells in the editor's upper border.
// Native working status and overflow hints keep their space; the editor and
// its keyboard handlers remain the original Pi component.
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

export interface AccountBorder {
  set(text?: string): void;
  dispose(): void;
}

interface BorderEditor {
  tui: TUI;
  renderTopBorder(width: number, hiddenLineCount: number): string;
}

export const accountBorder = (border: string, text: string | undefined): string => {
  if (!text) return border;
  const trailing = stripTerminalSequences(border).match(/─+$/)?.[0].length ?? 0;
  // Leave a separator on both sides and a border cell at each edge.
  const available = trailing - 4;
  if (available < visibleWidth("CCS")) return border;
  const label = truncateToWidth(text, available);
  const width = visibleWidth(border);
  const start = width - visibleWidth(label) - 3;
  return `${sliceByColumn(border, 0, start)} ${label} ${sliceByColumn(border, width - 1, 1)}`;
};

export const installAccountBorder = (): AccountBorder => {
  const prototype = CustomEditor.prototype as unknown as BorderEditor;
  const original = prototype.renderTopBorder;
  const editors = new Set<BorderEditor>();
  const state = { text: undefined as string | undefined };
  // The adapter only owns border rendering and redraw requests.
  const render: BorderEditor["renderTopBorder"] = function (this: BorderEditor, width, hiddenLineCount) {
    editors.add(this);
    return accountBorder(original.call(this, width, hiddenLineCount), state.text);
  };
  prototype.renderTopBorder = render;
  return {
    set: text => { state.text = text; editors.forEach(editor => editor.tui.requestRender()); },
    dispose: () => {
      if (prototype.renderTopBorder === render) prototype.renderTopBorder = original;
      editors.forEach(editor => editor.tui.requestRender());
      editors.clear();
    },
  };
};
