import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Bootstrap } from "./api";
import { ApprovalDialog, SettingsDialog } from "./Dialogs";
import { Icon } from "./icons";
import { applyHostEvent, fromSnapshot, type Projection } from "./projection";
import { Timeline } from "./Timeline";
import type { HostEvent, ModelEntry, RuntimeStatus, SessionSnapshot, SessionSummary, SubagentStatus, Workspace } from "./types";

function phaseLabel(phase: string) {
  return ({ idle: "就绪", model: "模型响应", tool: "执行工具", retry: "正在重试", compacting: "整理上下文" } as Record<string, string>)[phase] || phase;
}

export function App() {
  const started = useRef(false);
  const timeline = useRef<HTMLDivElement>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [subagents, setSubagents] = useState<SubagentStatus | null>(null);
  const [models, setModels] = useState<{ current: ModelEntry | null; providers: ModelEntry[] } | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const sessions = useMemo(() => bootstrap?.catalogs
    .find((catalog) => catalog.workspaceId === workspaceId)?.sessions || [], [bootstrap, workspaceId]);

  const showError = useCallback((error: unknown) => {
    setNotice(error instanceof Error ? error.message : "操作失败");
    window.setTimeout(() => setNotice(null), 5000);
  }, []);

  const loadRuntime = useCallback(async (id: string) => {
    const [runtimeStatus, subagentStatus] = await Promise.all([
      api.rpc<RuntimeStatus>(id, "runtime.status"),
      api.rpc<SubagentStatus>(id, "subagent.status"),
    ]);
    setRuntime(runtimeStatus);
    setSubagents(subagentStatus);
  }, []);

  const acceptOpen = useCallback((session: SessionSummary, snapshot: SessionSnapshot) => {
    setActiveSession(session);
    setWorkspaceId(session.workspaceId);
    setProjection(fromSnapshot(snapshot));
    setModels(snapshot.models);
    setSidebarOpen(false);
    setNotice(null);
    void loadRuntime(session.id).catch(showError);
  }, [loadRuntime, showError]);

  const openSession = useCallback(async (session: SessionSummary) => {
    setBusy(true);
    try {
      const opened = await api.openSession(session.id);
      acceptOpen(opened.session, opened.snapshot);
    } catch (error) { showError(error); } finally { setBusy(false); }
  }, [acceptOpen, showError]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void api.bootstrap().then((data) => {
      setBootstrap(data);
      setWorkspaceId(data.activeWorkspaceId);
      const first = data.catalogs.find((entry) => entry.workspaceId === data.activeWorkspaceId)?.sessions[0];
      if (first) void openSession(first);
    }).catch(showError);
  }, [openSession, showError]);

  useEffect(() => {
    if (!activeSession) return;
    setConnected(false);
    return api.events(activeSession.id, (event: HostEvent) => {
      setProjection((current) => current ? applyHostEvent(current, event) : current);
      if (event.durable && event.event === "session/name" && typeof event.data?.name === "string") {
        setActiveSession((current) => current ? { ...current, name: String(event.data?.name) } : current);
      }
      if (event.event?.startsWith("subagent/")) {
        void api.rpc<SubagentStatus>(activeSession.id, "subagent.status").then(setSubagents).catch(() => undefined);
      }
    }, setConnected);
  }, [activeSession?.id]);

  useEffect(() => {
    const element = timeline.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [projection?.events.length, projection?.state["partial-assistant"]]);

  const refreshCatalog = useCallback(async (targetWorkspace = workspaceId) => {
    if (!targetWorkspace || !bootstrap) return;
    const next = await api.listSessions(targetWorkspace);
    setBootstrap({ ...bootstrap, catalogs: bootstrap.catalogs.map((catalog) =>
      catalog.workspaceId === targetWorkspace ? { ...catalog, sessions: next } : catalog) });
  }, [bootstrap, workspaceId]);

  const newSession = async () => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const created = await api.createSession(workspaceId);
      acceptOpen(created.session, created.snapshot);
      await refreshCatalog(workspaceId);
    } catch (error) { showError(error); } finally { setBusy(false); }
  };

  const refreshSnapshot = async () => {
    if (!activeSession) return;
    const snapshot = await api.rpc<SessionSnapshot>(activeSession.id, "session.snapshot");
    setProjection(fromSnapshot(snapshot));
  };

  const send = async (mode: "auto" | "steer" = "auto") => {
    if (!activeSession || !composer.trim() || busy) return;
    const message = composer.trim();
    setComposer("");
    setBusy(true);
    try {
      if (message.startsWith("/")) {
        const result = await api.rpc<{ output?: unknown; error?: string }>(activeSession.id,
          "command.execute", { command: message });
        if (result.error) throw new Error(result.error);
        if (result.output != null) setNotice(typeof result.output === "string" ? result.output : JSON.stringify(result.output));
        await refreshSnapshot();
      } else if (mode === "steer") {
        await api.rpc(activeSession.id, "turn.steer", { message });
      } else if (projection?.state.phase && projection.state.phase !== "idle") {
        await api.rpc(activeSession.id, "turn.follow-up", { message });
      } else {
        await api.rpc(activeSession.id, "turn.submit", { message });
      }
    } catch (error) { setComposer(message); showError(error); } finally { setBusy(false); }
  };

  const resolveApproval = async (decision: "allow" | "allow-session" | "deny") => {
    const interaction = projection?.interactions[0];
    if (!interaction || !activeSession) return;
    setResolving(true);
    try {
      await api.rpc(activeSession.id, "interaction.resolve", { id: interaction.id, decision });
      setProjection((current) => current ? {
        ...current, interactions: current.interactions.filter((entry) => entry.id !== interaction.id),
      } : current);
    } catch (error) { showError(error); } finally { setResolving(false); }
  };

  const renameSession = async () => {
    if (!activeSession) return;
    const name = window.prompt("会话名称", activeSession.name || "");
    if (!name?.trim()) return;
    try {
      await api.rpc(activeSession.id, "session.rename", { name: name.trim() });
      setActiveSession({ ...activeSession, name: name.trim() });
      await refreshCatalog(activeSession.workspaceId);
    } catch (error) { showError(error); }
  };

  const forkSession = async () => {
    if (!activeSession) return;
    setBusy(true);
    try {
      const forked = await api.forkSession(activeSession.id,
        `${activeSession.name || "未命名会话"} · 分支`);
      acceptOpen(forked.session, forked.snapshot);
      await refreshCatalog(activeSession.workspaceId);
    } catch (error) { showError(error); } finally { setBusy(false); }
  };

  const selectModel = async (provider: string) => {
    if (!activeSession || !projection) return;
    try {
      const selected = await api.rpc<ModelEntry>(activeSession.id, "model.select", { provider });
      setModels((current) => current ? { ...current, current: selected } : current);
      setNotice(`已切换到 ${selected.model || provider}`);
    } catch (error) { showError(error); }
  };

  const addWorkspace = async (path: string) => {
    const workspace = await api.addWorkspace(path);
    const data = await api.bootstrap();
    setBootstrap(data);
    setWorkspaceId(workspace.id);
  };

  const removeWorkspace = async (workspace: Workspace) => {
    if (!window.confirm(`从 WebUI 移除工作区“${workspace.name}”？不会删除任何项目文件。`)) return;
    await api.removeWorkspace(workspace.id);
    const data = await api.bootstrap();
    setBootstrap(data);
    if (workspace.id === workspaceId) {
      setWorkspaceId(data.activeWorkspaceId);
      setActiveSession(null);
      setProjection(null);
    }
  };

  const activeWorkspace = bootstrap?.workspaces.find((entry) => entry.id === workspaceId);
  const phase = projection?.state.phase || "idle";

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
      <div className="brand"><div className="brand-mark">bb</div><div><strong>bb-agent</strong><span>Local harness</span></div>
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭导航"><Icon name="x" /></button></div>
      <button className="new-session button primary" type="button" onClick={newSession} disabled={!workspaceId || busy}>
        <Icon name="plus" />新会话
      </button>
      <label className="workspace-select"><span>工作区</span><select value={workspaceId || ""}
        onChange={(event) => setWorkspaceId(event.target.value)}>
        {bootstrap?.workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></label>
      <nav className="session-nav" aria-label="会话列表">
        <div className="nav-heading"><span>最近会话</span><button className="icon-button compact" type="button"
          onClick={() => void refreshCatalog()} aria-label="刷新会话"><Icon name="refresh" /></button></div>
        {sessions.length ? sessions.map((session) => <button type="button" key={session.id}
          className={`session-link ${session.id === activeSession?.id ? "active" : ""}`} onClick={() => void openSession(session)}>
          <span className="session-title">{session.name || "未命名会话"}</span>
          <span className="session-meta">{session.messageCount} 条消息 · {session.updatedAt ? new Date(session.updatedAt).toLocaleDateString() : "刚刚"}</span>
        </button>) : <div className="empty-nav">这个工作区还没有会话</div>}
      </nav>
      <button className="sidebar-settings" type="button" onClick={() => setSettingsOpen(true)}><Icon name="settings" />设置与插件</button>
    </aside>
    {sidebarOpen && <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}

    <main className="main-panel">
      <header className="topbar">
        <button className="icon-button mobile-only" type="button" onClick={() => setSidebarOpen(true)} aria-label="打开导航"><Icon name="menu" /></button>
        <div className="session-heading"><div className={`connection-dot ${connected ? "online" : ""}`} />
          <div><div className="title-row"><h1>{activeSession?.name || "新会话"}</h1>{activeSession &&
            <><button className="icon-button compact" type="button" onClick={renameSession} aria-label="重命名会话"><Icon name="edit" /></button>
              <button className="icon-button compact" type="button" onClick={forkSession} disabled={busy} aria-label="分叉会话"><Icon name="branch" /></button></>}</div>
            <span>{activeWorkspace?.path || "选择一个工作区开始"}</span></div></div>
        <div className="topbar-actions">
          {activeSession && <select className="model-select" aria-label="选择模型"
            value={models?.current?.id || ""} onChange={(event) => void selectModel(event.target.value)}>
            {models?.providers.map((model) => <option value={model.id} key={model.id}>{model.model || model.id}</option>)}
          </select>}
          <button className={`icon-button desktop-only ${inspectorOpen ? "active" : ""}`} type="button"
            onClick={() => setInspectorOpen((value) => !value)} aria-label="切换运行检查器"><Icon name="panel" /></button>
        </div>
      </header>

      <div className="workspace-body">
        <section className="conversation" aria-label="会话内容">
          <div className="timeline" ref={timeline} aria-live="polite">
            {projection ? <Timeline projection={projection} /> : <div className="welcome-state">
              <div className="welcome-icon"><Icon name="bot" /></div><h2>从本地工作区开始</h2>
              <p>会话、工具执行、审批和子代理状态会在这里实时呈现。</p>
              <button className="button primary" type="button" onClick={newSession} disabled={!workspaceId || busy}><Icon name="plus" />创建会话</button>
            </div>}
          </div>
          <div className="composer-wrap">
            <div className={`composer ${phase !== "idle" ? "is-active" : ""}`}>
              <textarea rows={1} value={composer} disabled={!activeSession} placeholder={activeSession ? "描述任务，或输入 /commands…" : "先创建或打开一个会话"}
                onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
                }} aria-label="给代理发送消息" />
              <div className="composer-footer"><span>{phase !== "idle" ? `${phaseLabel(phase)} · 新消息将排队` : "Enter 发送 · Shift+Enter 换行"}</span>
                <div>{phase !== "idle" && <button type="button" className="button compact-button ghost" disabled={!composer.trim() || busy}
                  onClick={() => void send("steer")}>立即引导</button>}
                  {phase !== "idle" ? <button type="button" className="send-button stop" onClick={() => activeSession && void api.rpc(activeSession.id, "turn.abort")} aria-label="停止运行"><Icon name="stop" /></button>
                    : <button type="button" className="send-button" disabled={!composer.trim() || busy || !activeSession} onClick={() => void send()} aria-label="发送"><Icon name="send" /></button>}</div></div>
            </div>
          </div>
        </section>

        {inspectorOpen && <aside className="inspector desktop-only">
          <div className="inspector-section"><div className="inspector-heading"><Icon name="activity" /><h2>当前运行</h2></div>
            <div className="run-card"><div><span className={`status-dot phase-${phase}`} />{phaseLabel(phase)}</div>
              <dl><div><dt>连接</dt><dd>{connected ? "实时" : "重连中"}</dd></div><div><dt>事件</dt><dd>{projection?.events.length || 0}</dd></div><div><dt>尝试</dt><dd>{projection?.state.attempt ?? "—"}</dd></div></dl></div></div>
          <div className="inspector-section"><div className="inspector-heading"><Icon name="branch" /><h2>子代理</h2><span>{subagents?.jobs.length || 0}</span></div>
            {subagents?.jobs.length ? subagents.jobs.map((job) => <div className="subagent-card" key={job.id}>
              <div><span className={`status-dot ${job.status === "running" ? "phase-model" : "phase-idle"}`} /><strong>{job.label}</strong></div><span>{job.provider} · {job.status}</span></div>) :
              <div className="inspector-empty">暂无子代理任务</div>}</div>
          <div className="inspector-section"><div className="inspector-heading"><Icon name="terminal" /><h2>能力</h2></div>
            <div className="metric-grid"><div><strong>{runtime?.tools.length ?? "—"}</strong><span>工具</span></div><div><strong>{runtime?.plugins.length ?? "—"}</strong><span>插件</span></div></div></div>
        </aside>}
      </div>
    </main>
    {projection?.interactions[0] && <ApprovalDialog interaction={projection.interactions[0]}
      resolving={resolving} onResolve={resolveApproval} />}
    {settingsOpen && <SettingsDialog workspaces={bootstrap?.workspaces || []} runtime={runtime}
      onClose={() => setSettingsOpen(false)} onAddWorkspace={addWorkspace}
      onRemoveWorkspace={removeWorkspace} />}
    {notice && <div className="toast" role="status">{notice}</div>}
  </div>;
}
