import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, setSupabaseToken, setUnauthorizedHandler } from "./api";
import Login from "./Login";
import { supabase, supabaseConfigured, type Session } from "./supabaseClient";
import type { Agent, AgentRun, FileChange, Message, ScanFinding, ScanVerdict, SystemInfo } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function ScanFindingsList({ findings }: { findings: ScanFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="scan-findings">
      {findings.map((finding, index) => (
        <li key={index}>
          <span className={"scan-severity scan-severity-" + finding.severity}>
            {finding.severity}
          </span>
          <div>
            <strong>
              {finding.technique}
              {finding.path ? " · " + finding.path : ""}
            </strong>
            <p>{finding.detail}</p>
            <code>{finding.excerpt}</code>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ScanSummary({ scan }: { scan: ScanVerdict }) {
  if (scan.findings.length === 0) {
    return (
      <div className="scan-summary scan-summary-clean">
        <span>✓</span> Injection scan: prompt and workspace files scanned, nothing found.
      </div>
    );
  }
  return (
    <article className="scan-warning">
      <strong>Injection scan flagged {scan.findings.length} item(s) — run proceeded</strong>
      <ScanFindingsList findings={scan.findings} />
    </article>
  );
}

function FileChangeBadge({ kind }: { kind: FileChange["kind"] }) {
  return <span className={"file-change-badge file-change-" + kind}>{kind}</span>;
}

function FileChangeDetail({ file }: { file: FileChange }) {
  if (file.isBinary) {
    return (
      <p className="file-change-binary-note">
        Binary file — {file.sizeBefore ?? "new"} → {file.sizeAfter ?? "removed"} bytes.
      </p>
    );
  }
  if (file.kind === "modified" && file.diff) {
    return (
      <pre className="file-diff">
        <code>
          {file.diff.map((line, index) => (
            <span
              key={index}
              className={
                "diff-line " +
                (line.added
                  ? "diff-line-added"
                  : line.removed
                    ? "diff-line-removed"
                    : "diff-line-context")
              }
            >
              {line.value}
            </span>
          ))}
        </code>
      </pre>
    );
  }
  if (file.kind === "created" && file.contentAfter !== undefined) {
    return (
      <pre className="file-diff">
        <code>{file.contentAfter}</code>
      </pre>
    );
  }
  if (file.kind === "deleted" && file.contentBefore !== undefined) {
    return (
      <pre className="file-diff">
        <code>{file.contentBefore}</code>
      </pre>
    );
  }
  return null;
}

function FileChangeRow({
  file,
  expanded,
  onToggle,
}: {
  file: FileChange;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="file-change-row">
      <button type="button" className="file-change-row-header" onClick={onToggle}>
        <span className={"file-change-caret " + (expanded ? "expanded" : "")}>▸</span>
        <FileChangeBadge kind={file.kind} />
        <code>{file.path}</code>
      </button>
      {expanded && <div className="file-change-body"><FileChangeDetail file={file} /></div>}
    </li>
  );
}

const fileChangeGroupOrder: FileChange["kind"][] = ["created", "modified", "deleted"];
const fileChangeGroupLabel: Record<FileChange["kind"], string> = {
  created: "Created",
  modified: "Modified",
  deleted: "Deleted",
};

function FileChangeGroupBar({ kind, count }: { kind: FileChange["kind"]; count: number }) {
  return (
    <div className={"file-change-group-bar file-change-group-" + kind}>
      {fileChangeGroupLabel[kind]} · {count} file{count === 1 ? "" : "s"}
    </div>
  );
}

function PendingChangesPanel({
  run,
  busy,
  onConfirm,
  onDiscard,
}: {
  run: AgentRun;
  busy: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const files = run.pendingChanges?.files ?? [];
  const kindsPresent = fileChangeGroupOrder.filter((kind) =>
    files.some((file) => file.kind === kind),
  );
  const groupByKind = kindsPresent.length > 1;

  const toggle = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <article className="scan-warning pending-changes-panel">
      <strong>
        Codex proposes {files.length} file change{files.length === 1 ? "" : "s"} — review before
        applying
      </strong>
      {groupByKind ? (
        kindsPresent.map((kind) => {
          const groupFiles = files.filter((file) => file.kind === kind);
          return (
            <div className="file-change-group" key={kind}>
              <FileChangeGroupBar kind={kind} count={groupFiles.length} />
              <ul className="file-change-list">
                {groupFiles.map((file) => (
                  <FileChangeRow
                    key={file.path}
                    file={file}
                    expanded={expandedPaths.has(file.path)}
                    onToggle={() => toggle(file.path)}
                  />
                ))}
              </ul>
            </div>
          );
        })
      ) : (
        <ul className="file-change-list">
          {files.map((file) => (
            <FileChangeRow
              key={file.path}
              file={file}
              expanded={expandedPaths.has(file.path)}
              onToggle={() => toggle(file.path)}
            />
          ))}
        </ul>
      )}
      {run.pendingChanges?.truncated && (
        <p className="file-change-truncated-note">
          Some files were too large to fully diff and were reported without detail.
        </p>
      )}
      <div className="pending-changes-actions">
        <button type="button" className="button button-danger" onClick={onDiscard} disabled={busy}>
          Discard
        </button>
        <button type="button" className="button button-primary" onClick={onConfirm} disabled={busy}>
          Confirm &amp; Apply
        </button>
      </div>
    </article>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setActiveRun(null);
      setError("Your session expired — please sign in again.");
      // Clears the local Supabase session too (not just this component's
      // state), so the app doesn't immediately bounce back in with the
      // same now-rejected token — this drops straight to the Login screen
      // via the `!session` branch below, through onAuthStateChange.
      if (supabase) void supabase.auth.signOut();
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!supabaseConfigured || !supabase) {
      setSessionChecked(true);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionChecked(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    setSupabaseToken(session?.access_token ?? "");
    if (session) {
      void bootstrap().catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    } else {
      setAgents([]);
      setSelectedId(null);
    }
  }, [session, bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    setSending(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim() || sending) return;
    const agentId = selected.id;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    setSending(true);
    try {
      const result = await api.sendMessage(agentId, content);
      if (selectedIdRef.current === agentId) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === agentId ? { ...agent, status: "busy" } : agent,
        ),
      );
      setSending(false);
      await pollRun(result.run.id, agentId);
    } catch (reason) {
      setSending(false);
      setError(reason instanceof Error ? reason.message : String(reason));
      if (selectedIdRef.current === agentId) setActiveRun(null);
      await refreshAgents();
    }
  };

  const confirmPendingRun = async (runId: string) => {
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.confirmRun(runId);
      if (selectedIdRef.current === run.agentId) setActiveRun(run);
      await Promise.all([refreshMessages(run.agentId), refreshAgents()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const discardPendingRun = async (runId: string) => {
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.discardRun(runId);
      if (selectedIdRef.current === run.agentId) setActiveRun(run);
      await Promise.all([refreshMessages(run.agentId), refreshAgents()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  };

  if (!sessionChecked) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Checking your session</h1>
          <Spinner />
        </section>
      </main>
    );
  }

  if (!session) {
    return <Login />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <div className="user-card">
          <div className="user-avatar">
            {(session.user.email ?? "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="user-meta">
            <span className="user-email" title={session.user.email ?? undefined}>
              {session.user.email}
            </span>
            <button className="user-signout" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-delete"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun && !sending ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                      {message.role === "assistant" &&
                        activeRun?.status === "pending_confirmation" &&
                        message.runId === activeRun.id && (
                          <p className="message-pending-note">
                            Proposed only — nothing has been applied yet. Review the changes
                            below before they take effect.
                          </p>
                        )}
                    </article>
                  ))
                )}
                {sending && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>sending…</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Scanning the prompt and starting the run…
                    </div>
                  </article>
                )}
                {!sending && activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {!sending && activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                {!sending && activeRun?.status === "blocked" && (
                  <article className="run-error scan-blocked">
                    <strong>Blocked — potential prompt injection detected</strong>
                    <span>Codex never started. The instruction never reached the model.</span>
                    <ScanFindingsList findings={activeRun.scan?.findings ?? []} />
                  </article>
                )}
                {!sending && activeRun?.status === "completed" && activeRun.scan && (
                  <ScanSummary scan={activeRun.scan} />
                )}
                {!sending && activeRun?.status === "pending_confirmation" && (
                  <PendingChangesPanel
                    run={activeRun}
                    busy={busy}
                    onConfirm={() => void confirmPendingRun(activeRun.id)}
                    onDiscard={() => void discardPendingRun(activeRun.id)}
                  />
                )}
                {!sending && activeRun?.status === "discarded" && (
                  <article className="run-error scan-discarded">
                    <strong>Proposal discarded</strong>
                    <span>You reviewed the proposed changes and discarded them — nothing was changed.</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : sending
                        ? "Sending…"
                        : activeRun?.status === "pending_confirmation"
                          ? "Ask Codex to adjust the proposed changes…"
                          : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    sending ||
                    selected.status === "stopped" ||
                    (selected.status === "busy" && activeRun?.status !== "pending_confirmation") ||
                    (activeRun != null && ["queued", "running"].includes(activeRun.status))
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      sending ||
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      (selected.status === "busy" && activeRun?.status !== "pending_confirmation") ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    {sending ? <Spinner /> : "↑"}
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
