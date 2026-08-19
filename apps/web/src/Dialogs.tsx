import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./icons";
import type { Interaction, RuntimeStatus, Workspace } from "./types";

function DialogFrame({ title, children, onClose, dangerous = false }: {
  title: string; children: ReactNode; onClose?: () => void; dangerous?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => dialog.current?.querySelector<HTMLElement>("button, input, select")?.focus(), []);
  const trap = (event: KeyboardEvent) => {
    if (event.key === "Escape" && onClose) onClose();
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="dialog-backdrop" role="presentation">
    <div className={`dialog ${dangerous ? "dialog-danger" : ""}`} role="dialog" aria-modal="true"
      aria-labelledby="dialog-title" ref={dialog} onKeyDown={trap}>
      <header><h2 id="dialog-title">{title}</h2>{onClose &&
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="x" /></button>}</header>
      {children}
    </div>
  </div>;
}

export function ApprovalDialog({ interaction, resolving, onResolve }: {
  interaction: Interaction; resolving: boolean;
  onResolve: (decision: "allow" | "allow-session" | "deny") => void;
}) {
  return <DialogFrame title={interaction.title || "批准工具执行？"} dangerous>
    <div className="approval-symbol"><Icon name="shield" /></div>
    <p className="dialog-copy">代理需要你的确认才能继续。请核对目标和参数。</p>
    <pre className="approval-detail">{interaction.message}</pre>
    <div className="dialog-actions approval-actions">
      <button type="button" className="button ghost" disabled={resolving} onClick={() => onResolve("deny")}>拒绝</button>
      <button type="button" className="button secondary" disabled={resolving}
        onClick={() => onResolve("allow-session")}>本会话允许</button>
      <button type="button" className="button primary" disabled={resolving} onClick={() => onResolve("allow")}>
        <Icon name="check" />仅允许一次
      </button>
    </div>
  </DialogFrame>;
}

export function SettingsDialog({ workspaces, runtime, onClose, onAddWorkspace, onRemoveWorkspace }: {
  workspaces: Workspace[]; runtime: RuntimeStatus | null; onClose: () => void;
  onAddWorkspace: (path: string) => Promise<void>;
  onRemoveWorkspace?: (workspace: Workspace) => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!path.trim()) return;
    setBusy(true);
    try { await onAddWorkspace(path.trim()); setPath(""); } finally { setBusy(false); }
  };
  return <DialogFrame title="设置与运行时" onClose={onClose}>
    <div className="settings-sections">
      <section>
        <div className="section-heading"><div><h3>工作区</h3><p>只有这里列出的真实目录可被 WebUI 打开。</p></div></div>
        <div className="workspace-list">{workspaces.map((workspace) =>
          <div className="workspace-row" key={workspace.id}><Icon name="folder" /><div><strong>{workspace.name}</strong><span>{workspace.path}</span></div>
            {onRemoveWorkspace && workspaces.length > 1 && <button className="icon-button compact" type="button"
              aria-label={`移除工作区 ${workspace.name}`} onClick={() => void onRemoveWorkspace(workspace)}><Icon name="x" /></button>}</div>)}</div>
        <div className="inline-form"><input value={path} onChange={(event) => setPath(event.target.value)}
          placeholder="输入本机项目绝对路径" aria-label="工作区路径" />
          <button className="button secondary" type="button" disabled={busy || !path.trim()} onClick={submit}>添加</button></div>
      </section>
      <section>
        <div className="section-heading"><div><h3>插件</h3><p>{runtime ? `${runtime.plugins.length} 个已加载插件` : "打开会话后显示"}</p></div></div>
        <div className="chip-list">{runtime?.plugins.map((plugin) => <span className="chip" key={plugin.id}>{plugin.id}</span>)}</div>
      </section>
      <section>
        <div className="section-heading"><div><h3>工具</h3><p>{runtime ? `${runtime.tools.length} 个模型工具` : "暂无信息"}</p></div></div>
        <div className="tool-inventory">{runtime?.tools.map((tool) => <div key={tool.name}><code>{tool.name}</code><span>{tool.description}</span></div>)}</div>
      </section>
    </div>
  </DialogFrame>;
}
