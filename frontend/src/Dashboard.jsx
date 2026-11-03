import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity, ArrowRight, Bell, CalendarDays, Check, CheckCircle2, ChevronDown,
  CircleAlert, CircleDot, Command, LayoutDashboard, ListChecks, LogOut, Plus,
  Search, Sparkles, ThumbsDown, ThumbsUp, UsersRound, X, XCircle,
} from 'lucide-react'
import './Dashboard.css'

const SESSION_KEY = 'smartassign.session'
const STATUSES = ['BACKLOG', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED']
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT']
const POLL_INTERVAL_MS = 3000

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { return null }
}

async function api(path, { token, ...options } = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.error || 'The request could not be completed.')
    error.status = response.status
    error.details = body?.details
    throw error
  }
  return body
}

function label(value = '') {
  return value.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

function dateLabel(value) {
  if (!value) return 'No deadline'
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(value))
}

// ── active statuses for polling ──────────────────────────────────────────────
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running'])

export default function Dashboard() {
  const [session, setSession] = useState(readSession)
  const [view, setView] = useState('overview')
  const [tasks, setTasks] = useState([])
  const [teams, setTeams] = useState([])
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [modal, setModal] = useState(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [notice, setNotice] = useState('')

  // recommendation state: map of task_id → { run_id, status, recommendations, error }
  const [agentRuns, setAgentRuns] = useState({})
  // which task's recommendations we're viewing
  const [recTaskId, setRecTaskId] = useState(null)
  const pollTimers = useRef({})

  // ── data loading ───────────────────────────────────────────────────────────
  async function loadWorkspace(currentSession) {
    setBusy(true)
    setLoadError('')
    try {
      const [nextTasks, nextTeams] = await Promise.all([
        api('/tasks', { token: currentSession.access_token }),
        api('/teams', { token: currentSession.access_token }),
      ])
      setTasks(nextTasks)
      setTeams(nextTeams)
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        localStorage.removeItem(SESSION_KEY)
        setSession(null)
      } else {
        setLoadError(error.message === 'Failed to fetch'
          ? 'The API is unavailable. Start the backend on port 3000, then retry.'
          : error.message)
      }
    } finally { setBusy(false) }
  }

  useEffect(() => {
    if (session?.access_token) loadWorkspace(session)
  }, [session?.access_token])

  // ── auth ───────────────────────────────────────────────────────────────────
  function acceptSession(nextSession) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession))
    setSession(nextSession)
    setView('overview')
    setNotice(`Welcome, ${nextSession.user.name.split(' ')[0]}.`)
  }

  function signOut() {
    localStorage.removeItem(SESSION_KEY)
    setSession(null)
    setTasks([])
    setTeams([])
    setAgentRuns({})
    setNotice('')
    Object.values(pollTimers.current).forEach(clearInterval)
    pollTimers.current = {}
  }

  // ── team / task mutations ──────────────────────────────────────────────────
  async function createTeam(name) {
    const team = await api('/teams', {
      token: session.access_token,
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    setTeams((c) => [...c, team].sort((a, b) => a.name.localeCompare(b.name)))
    setNotice(`${team.name} is ready for work.`)
    setModal(null)
  }

  async function createTask(payload) {
    const task = await api('/tasks', {
      token: session.access_token,
      method: 'POST',
      body: JSON.stringify(payload),
    })
    setTasks((c) => [task, ...c])
    setNotice('Task added to the team queue.')
    setModal(null)
  }

  // ── recommendation workflow ────────────────────────────────────────────────
  const pollRun = useCallback(async (taskId, runId) => {
    try {
      const run = await api(`/agent-runs/${runId}`, { token: session.access_token })
      setAgentRuns((prev) => ({ ...prev, [taskId]: { run_id: runId, ...run } }))

      // Stop polling once the run reaches a terminal state
      if (!ACTIVE_RUN_STATUSES.has(run.status)) {
        clearInterval(pollTimers.current[taskId])
        delete pollTimers.current[taskId]
      }
    } catch {
      // ignore transient poll errors
    }
  }, [session?.access_token])

  async function startRecommendation(taskId) {
    setAgentRuns((prev) => ({ ...prev, [taskId]: { status: 'queued', recommendations: [] } }))
    try {
      const { run_id: runId } = await api(`/tasks/${taskId}/recommend`, {
        token: session.access_token,
        method: 'POST',
      })
      setAgentRuns((prev) => ({ ...prev, [taskId]: { run_id: runId, status: 'queued', recommendations: [] } }))

      // Start polling
      if (pollTimers.current[taskId]) clearInterval(pollTimers.current[taskId])
      pollTimers.current[taskId] = setInterval(() => pollRun(taskId, runId), POLL_INTERVAL_MS)
      pollRun(taskId, runId)
    } catch (error) {
      setAgentRuns((prev) => ({ ...prev, [taskId]: { status: 'failed', error: error.message, recommendations: [] } }))
      setNotice(`Could not start recommendation: ${error.message}`)
    }
  }

  function openRecommendations(taskId) {
    setRecTaskId(taskId)
    setView('recommendations')
  }

  async function approveRecommendation(recId, taskId) {
    try {
      await api(`/recommendations/${recId}/approve`, {
        token: session.access_token,
        method: 'POST',
        body: JSON.stringify({}),
      })
      setNotice('Assignment approved and committed.')
      // refresh tasks so status changes to IN_PROGRESS
      await loadWorkspace(session)
      setAgentRuns((prev) => {
        const run = prev[taskId]
        if (!run) return prev
        return { ...prev, [taskId]: { ...run, status: 'completed' } }
      })
    } catch (error) {
      setNotice(`Approval failed: ${error.message}`)
    }
  }

  async function rejectRecommendation(recId, taskId) {
    try {
      await api(`/recommendations/${recId}/reject`, {
        token: session.access_token,
        method: 'POST',
        body: JSON.stringify({}),
      })
      setNotice('Recommendation rejected.')
      // refresh recommendations list
      const recs = await api(`/tasks/${taskId}/recommendations`, { token: session.access_token })
      setAgentRuns((prev) => ({
        ...prev,
        [taskId]: { ...prev[taskId], recommendations: recs },
      }))
    } catch (error) {
      setNotice(`Rejection failed: ${error.message}`)
    }
  }

  // Cleanup timers on unmount
  useEffect(() => {
    return () => Object.values(pollTimers.current).forEach(clearInterval)
  }, [])

  // ── derived values ─────────────────────────────────────────────────────────
  if (!session) return <AuthScreen onAuthenticated={acceptSession} />

  const openTasks = tasks.filter((t) => !['COMPLETED', 'CANCELLED'].includes(t.status))
  const dueSoon = openTasks.filter((t) => {
    if (!t.deadline) return false
    const remaining = new Date(t.deadline).getTime() - Date.now()
    return remaining >= 0 && remaining <= 7 * 24 * 60 * 60 * 1000
  })
  const visibleTasks = tasks.filter((t) =>
    (statusFilter === 'ALL' || t.status === statusFilter) &&
    `${t.title} ${t.description}`.toLowerCase().includes(query.toLowerCase()),
  )
  const openTaskModal = () => setModal(teams.length ? 'task' : 'team')

  // Active runs count for sidebar badge
  const activeRunCount = Object.values(agentRuns).filter((r) =>
    ACTIVE_RUN_STATUSES.has(r.status),
  ).length

  // Latest run (most recent terminal state with recs) for sidebar strip
  const latestRunEntry = Object.entries(agentRuns)
    .filter(([, r]) => r.recommendations?.length || r.status === 'awaiting_approval')
    .sort(([, a], [, b]) => {
      const order = { awaiting_approval: 0, completed: 1, no_match: 2, failed: 3 }
      return (order[a.status] ?? 9) - (order[b.status] ?? 9)
    })[0]

  const recTask = recTaskId ? tasks.find((t) => t.id === recTaskId) : null
  const recRun = recTaskId ? agentRuns[recTaskId] : null

  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => setView('overview')}>
          <span className="brand-mark"><Command size={18} /></span>
          <span>smartassign<span className="brand-dot">.</span></span>
        </a>
        <div className="org-switcher">
          <span className="org-avatar">{session.organization.name.slice(0, 1).toUpperCase()}</span>
          <span className="org-copy"><strong>{session.organization.name}</strong><small>Organization</small></span>
          <ChevronDown size={14} />
        </div>
        <span className="nav-caption">WORKSPACE</span>
        <nav className="main-nav" aria-label="Main navigation">
          <NavButton active={view === 'overview'} icon={<LayoutDashboard size={17} />} onClick={() => setView('overview')}>Overview</NavButton>
          <NavButton active={view === 'tasks'} icon={<ListChecks size={17} />} onClick={() => setView('tasks')}>
            Tasks <span className="nav-count">{openTasks.length}</span>
          </NavButton>
          <NavButton active={view === 'teams'} icon={<UsersRound size={17} />} onClick={() => setView('teams')}>Teams</NavButton>
          <NavButton
            active={view === 'recommendations'}
            icon={<Sparkles size={17} />}
            onClick={() => setView('recommendations')}
          >
            Allocate
            {activeRunCount > 0 && <span className="nav-count nav-count-pulse">{activeRunCount}</span>}
          </NavButton>
        </nav>
        <div className="sidebar-spacer" />

        {/* Smart allocation status strip */}
        {latestRunEntry ? (
          <AgentStatusStrip
            run={latestRunEntry[1]}
            task={tasks.find((t) => t.id === latestRunEntry[0])}
            onView={() => openRecommendations(latestRunEntry[0])}
          />
        ) : (
          <div className="agent-note">
            <span className="agent-note-icon"><Sparkles size={16} /></span>
            <strong>Smart allocation</strong>
            <p>Open a task and click "Get recommendation" to start the workflow.</p>
            <span className="dev-label"><i /> CONNECTED</span>
          </div>
        )}

        <button className="profile-row" onClick={signOut} title="Sign out">
          <span className="profile-avatar">{session.user.name.slice(0, 1).toUpperCase()}</span>
          <span className="profile-copy"><strong>{session.user.name}</strong><small>{session.user.email}</small></span>
          <LogOut size={15} />
        </button>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span><b>/</b>
            <strong>{view === 'recommendations' && recTask ? `Allocate — ${recTask.title}` : label(view)}</strong>
          </div>
          <div className="topbar-right">
            <span className="api-state"><i /> API workspace</span>
            <button className="icon-button" type="button" title="Notifications not connected" aria-label="Notifications" disabled><Bell size={16} /></button>
            <button className="top-avatar" onClick={signOut} title="Sign out">{session.user.name.slice(0, 1).toUpperCase()}</button>
          </div>
        </header>
        <div className="page-content">
          {notice && (
            <div className="toast" role="status">
              <Check size={15} />{notice}
              <button onClick={() => setNotice('')} aria-label="Dismiss"><X size={14} /></button>
            </div>
          )}
          {loadError && (
            <div className="alert-banner" role="alert">
              <CircleAlert size={16} />{loadError}
              <button onClick={() => loadWorkspace(session)}>Retry</button>
            </div>
          )}
          {view === 'overview' && (
            <Overview
              session={session} tasks={tasks} teams={teams}
              openTasks={openTasks} dueSoon={dueSoon} loading={busy}
              onCreateTask={openTaskModal} onCreateTeam={() => setModal('team')}
              onViewTasks={() => setView('tasks')}
            />
          )}
          {view === 'tasks' && (
            <TasksView
              tasks={visibleTasks} teams={teams} loading={busy}
              query={query} statusFilter={statusFilter}
              onQuery={setQuery} onStatus={setStatusFilter}
              onCreate={openTaskModal}
              agentRuns={agentRuns}
              onRecommend={startRecommendation}
              onViewRecs={openRecommendations}
            />
          )}
          {view === 'teams' && (
            <TeamsView teams={teams} loading={busy} onCreate={() => setModal('team')} />
          )}
          {view === 'recommendations' && (
            <RecommendationsView
              task={recTask}
              run={recRun}
              tasks={tasks}
              teams={teams}
              agentRuns={agentRuns}
              onSelectTask={(id) => { setRecTaskId(id) }}
              onRecommend={startRecommendation}
              onApprove={approveRecommendation}
              onReject={rejectRecommendation}
              onBack={() => setView('tasks')}
            />
          )}
        </div>
      </main>
      {modal === 'team' && <TeamModal onClose={() => setModal(null)} onSubmit={createTeam} />}
      {modal === 'task' && <TaskModal teams={teams} onClose={() => setModal(null)} onSubmit={createTask} />}
    </div>
  )
}

// ── Nav helper ────────────────────────────────────────────────────────────────
function NavButton({ active, icon, children, onClick }) {
  return (
    <button className={`nav-item${active ? ' is-active' : ''}`} onClick={onClick}>
      {icon}<span className="nav-text">{children}</span>
    </button>
  )
}

// ── Sidebar agent status strip ─────────────────────────────────────────────
function AgentStatusStrip({ run, task, onView }) {
  const statusMeta = {
    queued:             { icon: <CircleDot size={13} />, tone: 'strip-queued',    text: 'Queued…' },
    running:            { icon: <CircleDot size={13} />, tone: 'strip-running',   text: 'Analysing…' },
    awaiting_approval:  { icon: <Sparkles  size={13} />, tone: 'strip-approval',  text: 'Needs your review' },
    completed:          { icon: <CheckCircle2 size={13}/>, tone: 'strip-done',    text: 'Assignment committed' },
    no_match:           { icon: <XCircle  size={13} />, tone: 'strip-nomatch',   text: 'No eligible match' },
    failed:             { icon: <XCircle  size={13} />, tone: 'strip-failed',    text: 'Workflow failed' },
  }
  const meta = statusMeta[run?.status] ?? statusMeta.running

  return (
    <div className={`agent-status-strip ${meta.tone}`}>
      <span className="agent-status-icon">{meta.icon}</span>
      <div className="agent-status-copy">
        <strong>Smart allocation</strong>
        {task && <span className="agent-status-task">{task.title}</span>}
        <span className="agent-status-state">{meta.text}</span>
      </div>
      {(run?.status === 'awaiting_approval' || run?.recommendations?.length > 0) && (
        <button className="agent-status-action" onClick={onView} aria-label="View recommendations">
          <ArrowRight size={13} />
        </button>
      )}
    </div>
  )
}

// ── Auth screen ────────────────────────────────────────────────────────────
function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('register')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [organizations, setOrganizations] = useState([])
  const isRegister = mode === 'register'

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    try {
      const result = await api(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(values) })
      onAuthenticated(result)
    } catch (requestError) {
      if (requestError.status === 409 && requestError.details?.organizations) {
        setOrganizations(requestError.details.organizations)
        setError('Choose an organization and sign in again.')
      } else {
        setError(requestError.message === 'Failed to fetch'
          ? 'The API is not reachable. Start the backend and retry.'
          : requestError.message)
      }
    } finally { setBusy(false) }
  }

  function changeMode(nextMode) { setMode(nextMode); setError(''); setOrganizations([]) }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <a className="brand auth-brand" href="#home">
          <span className="brand-mark"><Command size={18} /></span>
          <span>smartassign<span className="brand-dot">.</span></span>
        </a>
        <div className="story-copy">
          <span className="eyebrow story-eyebrow"><i /> TEAM OPERATIONS, IN SYNC</span>
          <h1>Good work starts with the <em>right match.</em></h1>
          <p>Bring people, priorities, and capacity into one clear view. Make the next assignment with the whole team in mind.</p>
          <div className="story-footline"><span />One workspace for work that moves.</div>
        </div>
        <div className="story-footer"><span>SMARTASSIGN / TEAM WORKSPACE</span><span>01 — 03</span></div>
      </section>
      <section className="auth-panel">
        <div className="mobile-brand"><span className="brand-mark"><Command size={17} /></span>smartassign<span className="brand-dot">.</span></div>
        <div className="auth-box">
          <div className="auth-heading">
            <span className="eyebrow">{isRegister ? 'GET YOUR TEAM STARTED' : 'WELCOME BACK'}</span>
            <h2>{isRegister ? 'Create your workspace' : 'Sign in to your workspace'}</h2>
            <p>{isRegister ? 'Set up your organization and admin account.' : 'Pick up where your team left off.'}</p>
          </div>
          <div className="auth-tabs" role="tablist" aria-label="Account action">
            <button role="tab" aria-selected={isRegister} className={isRegister ? 'selected' : ''} onClick={() => changeMode('register')}>Create workspace</button>
            <button role="tab" aria-selected={!isRegister} className={!isRegister ? 'selected' : ''} onClick={() => changeMode('login')}>Sign in</button>
          </div>
          <form className="auth-form" onSubmit={submit}>
            {isRegister && <Field label="Your name"><input name="name" autoComplete="name" placeholder="Alex Morgan" maxLength="120" required /></Field>}
            <Field label="Work email"><input name="email" type="email" autoComplete="email" placeholder="alex@company.com" required /></Field>
            <Field label="Password"><input name="password" type="password" autoComplete={isRegister ? 'new-password' : 'current-password'} placeholder={isRegister ? 'At least 12 characters' : 'Your password'} minLength={isRegister ? 12 : 1} maxLength="128" required /></Field>
            {isRegister && <Field label="Organization name"><input name="organization_name" placeholder="Northstar Studio" maxLength="200" required /></Field>}
            {organizations.length > 0 && (
              <Field label="Organization">
                <select name="organization_id" defaultValue={organizations[0].id}>
                  {organizations.map((o) => <option value={o.id} key={o.id}>{o.name}</option>)}
                </select>
              </Field>
            )}
            {error && <FormError>{error}</FormError>}
            <button className="button button-primary auth-submit" type="submit" disabled={busy}>
              {busy ? 'Please wait…' : isRegister ? 'Create workspace' : 'Sign in'}
              {!busy && <ArrowRight size={16} />}
            </button>
          </form>
          <p className="auth-legal">Your team's information stays within its organization workspace.</p>
        </div>
        <div className="auth-bottom"><span>SMARTASSIGN</span><span>SECURE TEAM ACCESS</span></div>
      </section>
    </main>
  )
}

// ── Field ─────────────────────────────────────────────────────────────────────
function Field({ label: title, children }) {
  return <label className="field"><span>{title}</span>{children}</label>
}

// ── Overview ──────────────────────────────────────────────────────────────────
function Overview({ session, tasks, teams, openTasks, dueSoon, loading, onCreateTask, onCreateTeam, onViewTasks }) {
  const statuses = STATUSES.slice(0, 4).map((status) => ({
    status,
    count: tasks.filter((t) => t.status === status).length,
  }))
  const scale = Math.max(1, ...statuses.map((s) => s.count))
  const recent = [...tasks]
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 5)

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TEAM PULSE / {new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}</span>
          <h1>Good work, {session.user.name.split(' ')[0]}.</h1>
          <p>Here's the shape of your team's work today.</p>
        </div>
        <button className="button button-primary" onClick={onCreateTask}><Plus size={16} />New task</button>
      </div>

      <section className="metric-grid" aria-label="Workspace summary">
        <Metric label="Open tasks" value={loading ? '—' : openTasks.length} detail="In the team queue" icon={<ListChecks size={17} />} tone="mint" />
        <Metric label="Due this week" value={loading ? '—' : dueSoon.length} detail="Next 7 days" icon={<CalendarDays size={17} />} tone="peach" />
        <Metric label="Teams" value={loading ? '—' : teams.length} detail="In this workspace" icon={<UsersRound size={17} />} tone="blue" />
        <Metric label="Tasks tracked" value={loading ? '—' : tasks.length} detail="All statuses" icon={<Activity size={17} />} tone="yellow" />
      </section>

      {teams.length === 0 && !loading && (
        <section className="setup-strip">
          <span className="setup-icon"><UsersRound size={19} /></span>
          <div><strong>Start with your first team</strong><p>Create a team to organize tasks and get your workspace moving.</p></div>
          <button className="button button-secondary" onClick={onCreateTeam}>Create team <ArrowRight size={14} /></button>
        </section>
      )}

      <div className="overview-grid">
        <section className="panel task-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">LIVE QUEUE</span><h2>Recent tasks</h2></div>
            <button className="text-button" onClick={onViewTasks}>View all <ArrowRight size={14} /></button>
          </div>
          {loading
            ? <LoadingRows />
            : recent.length
              ? <TaskTable tasks={recent} teams={teams} compact />
              : <EmptyState title="No tasks yet" detail={teams.length ? 'Add the first task to your team queue.' : 'Create a team first, then add a task.'} action={teams.length ? 'Create task' : 'Create team'} onAction={teams.length ? onCreateTask : onCreateTeam} />
          }
        </section>
        <section className="panel rhythm-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">WORK RHYTHM</span><h2>Task status</h2></div>
            <span className="quiet-icon"><Activity size={15} /></span>
          </div>
          <div className="status-chart">
            {statuses.map(({ status, count }) => (
              <div className="status-row" key={status}>
                <span>{label(status)}</span>
                <div className="bar-track">
                  <span className={`bar-fill bar-${status.toLowerCase()}`} style={{ width: `${count ? Math.max(8, count / scale * 100) : 0}%` }} />
                </div>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
          <div className="chart-foot"><span><i />Current tasks</span><span>{tasks.length} total</span></div>
        </section>
      </div>
    </>
  )
}

function Metric({ label: title, value, detail, icon, tone }) {
  return (
    <article className="metric">
      <span className={`metric-icon ${tone}`}>{icon}</span>
      <span className="metric-title">{title}</span>
      <strong className="metric-value">{value}</strong>
      <span className="metric-detail">{detail}</span>
    </article>
  )
}

// ── Tasks view ────────────────────────────────────────────────────────────────
function TasksView({ tasks, teams, loading, query, statusFilter, onQuery, onStatus, onCreate, agentRuns, onRecommend, onViewRecs }) {
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">WORKSPACE / TASKS</span>
          <h1>Task queue</h1>
          <p>Keep priorities, deadlines, and progress in view.</p>
        </div>
        <button className="button button-primary" onClick={onCreate}><Plus size={16} />New task</button>
      </div>
      <section className="panel task-list-panel">
        <div className="list-toolbar">
          <label className="search-box">
            <Search size={15} />
            <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search tasks" aria-label="Search tasks" />
          </label>
          <label className="filter-select">
            <span className="sr-only">Filter by status</span>
            <select value={statusFilter} onChange={(e) => onStatus(e.target.value)}>
              <option value="ALL">All statuses</option>
              {STATUSES.map((s) => <option value={s} key={s}>{label(s)}</option>)}
            </select>
            <ChevronDown size={13} />
          </label>
          <span className="result-count">{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span>
        </div>
        {loading
          ? <LoadingRows />
          : tasks.length
            ? <TaskTable tasks={tasks} teams={teams} agentRuns={agentRuns} onRecommend={onRecommend} onViewRecs={onViewRecs} />
            : <EmptyState title="Nothing in this view" detail="Try another filter, or create a task to get started." action="Create task" onAction={onCreate} />
        }
      </section>
    </>
  )
}

// ── Task table ────────────────────────────────────────────────────────────────
function TaskTable({ tasks, teams, compact = false, agentRuns = {}, onRecommend, onViewRecs }) {
  const names = new Map(teams.map((t) => [t.id, t.name]))
  const canRecommend = !!onRecommend

  return (
    <div className={`table-scroll${compact ? ' compact' : ''}`}>
      <table className="task-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Team</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Due date</th>
            {canRecommend && <th>Allocate</th>}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const run = agentRuns[task.id]
            const isOpen = !['COMPLETED', 'CANCELLED'].includes(task.status)
            return (
              <tr key={task.id}>
                <td>
                  <div className="task-name">
                    <span className={`task-check${task.status === 'COMPLETED' ? ' checked' : ''}`}>
                      {task.status === 'COMPLETED' && <Check size={11} />}
                    </span>
                    <span>
                      <strong>{task.title}</strong>
                      <small>{task.estimated_hours ? `${task.estimated_hours}h estimate` : task.description || 'No description'}</small>
                    </span>
                  </div>
                </td>
                <td><span className="team-name"><i />{names.get(task.team_id) || 'Team'}</span></td>
                <td><span className={`priority priority-${task.priority.toLowerCase()}`}><i />{label(task.priority)}</span></td>
                <td><span className={`status-pill status-${task.status.toLowerCase()}`}>{label(task.status)}</span></td>
                <td><span className="due-date"><CalendarDays size={13} />{dateLabel(task.deadline)}</span></td>
                {canRecommend && (
                  <td>
                    <RunCell run={run} taskId={task.id} isOpen={isOpen} onRecommend={onRecommend} onView={onViewRecs} />
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Run status cell inside task table ─────────────────────────────────────────
function RunCell({ run, taskId, isOpen, onRecommend, onView }) {
  if (!isOpen) return <span className="run-cell-na">—</span>

  if (!run) {
    return (
      <button className="button button-secondary run-btn" onClick={() => onRecommend(taskId)}>
        <Sparkles size={12} />Get rec.
      </button>
    )
  }

  const meta = {
    queued:            { pill: 'run-queued',    text: 'Queued' },
    running:           { pill: 'run-running',   text: 'Analysing…' },
    awaiting_approval: { pill: 'run-approval',  text: 'Review ready' },
    completed:         { pill: 'run-done',      text: 'Done' },
    no_match:          { pill: 'run-nomatch',   text: 'No match' },
    failed:            { pill: 'run-failed',    text: 'Failed' },
  }
  const m = meta[run.status] ?? meta.running
  const canView = ['awaiting_approval', 'completed', 'no_match'].includes(run.status)

  return (
    <span className="run-cell">
      <span className={`run-pill ${m.pill}`}>{m.text}</span>
      {canView && (
        <button className="run-view-btn" onClick={() => onView(taskId)} aria-label="View recommendations">
          <ArrowRight size={11} />
        </button>
      )}
    </span>
  )
}

// ── Recommendations view ───────────────────────────────────────────────────────
function RecommendationsView({ task, run, tasks, teams, agentRuns, onSelectTask, onRecommend, onApprove, onReject, onBack }) {
  const openTasks = tasks.filter((t) => !['COMPLETED', 'CANCELLED'].includes(t.status))

  // If no task selected yet, show a picker
  if (!task) {
    return (
      <>
        <div className="page-heading">
          <div>
            <span className="eyebrow">SMART ALLOCATION</span>
            <h1>Allocate a task</h1>
            <p>Select an open task to run the recommendation workflow.</p>
          </div>
        </div>
        <section className="panel">
          {openTasks.length === 0
            ? <EmptyState title="No open tasks" detail="All tasks are complete or cancelled." action="Go to tasks" onAction={onBack} />
            : (
              <ul className="task-picker">
                {openTasks.map((t) => {
                  const run = agentRuns[t.id]
                  const team = teams.find((tm) => tm.id === t.team_id)
                  return (
                    <li key={t.id} className="task-picker-row">
                      <button className="task-picker-btn" onClick={() => onSelectTask(t.id)}>
                        <span className={`priority priority-${t.priority.toLowerCase()}`}><i /></span>
                        <span className="task-picker-title">{t.title}</span>
                        <span className="task-picker-team">{team?.name ?? '—'}</span>
                        {run && <span className={`run-pill ${runPillClass(run.status)}`}>{runPillText(run.status)}</span>}
                        <ArrowRight size={13} className="task-picker-arrow" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )
          }
        </section>
      </>
    )
  }

  const isOpen = !['COMPLETED', 'CANCELLED'].includes(task.status)
  const recs = run?.recommendations ?? []
  const isActive = run && ACTIVE_RUN_STATUSES.has(run.status)

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SMART ALLOCATION / {task.status}</span>
          <h1>{task.title}</h1>
          <p>{task.description || 'No description provided.'}</p>
        </div>
        <div className="page-heading-actions">
          <button className="button button-quiet" onClick={() => onSelectTask(null)}>
            ← All tasks
          </button>
          {isOpen && !isActive && (
            <button className="button button-primary" onClick={() => onRecommend(task.id)}>
              <Sparkles size={15} />
              {run ? 'Re-run' : 'Get recommendation'}
            </button>
          )}
        </div>
      </div>

      {/* Task meta strip */}
      <div className="rec-task-meta">
        <span className={`priority priority-${task.priority.toLowerCase()}`}><i />{label(task.priority)}</span>
        {task.deadline && <span className="due-date"><CalendarDays size={13} />{dateLabel(task.deadline)}</span>}
        {task.estimated_hours && <span className="rec-meta-item"><Activity size={13} />{task.estimated_hours}h estimated</span>}
        <span className={`status-pill status-${task.status.toLowerCase()}`}>{label(task.status)}</span>
      </div>

      {/* Run status banner */}
      {run && <RunStatusBanner run={run} />}

      {/* Recommendation cards */}
      {recs.length > 0 && (
        <section className="rec-section">
          <div className="rec-section-head">
            <span className="eyebrow">RANKED CANDIDATES</span>
            <h2>{recs.length} recommendation{recs.length !== 1 ? 's' : ''}</h2>
          </div>
          <div className="rec-grid">
            {recs.map((rec, idx) => (
              <RecommendationCard
                key={rec.id}
                rec={rec}
                rank={idx + 1}
                taskId={task.id}
                canAct={run?.status === 'awaiting_approval' && isOpen}
                onApprove={onApprove}
                onReject={onReject}
              />
            ))}
          </div>
        </section>
      )}

      {!run && isOpen && (
        <div className="rec-empty-state">
          <span className="rec-empty-icon"><Sparkles size={22} /></span>
          <strong>No recommendations yet</strong>
          <p>Run the smart allocation workflow to get AI-ranked candidates based on skills, availability, and workload fairness.</p>
          <button className="button button-primary" onClick={() => onRecommend(task.id)}>
            <Sparkles size={15} />Get recommendation
          </button>
        </div>
      )}
    </>
  )
}

function runPillClass(status) {
  return {
    queued: 'run-queued', running: 'run-running',
    awaiting_approval: 'run-approval', completed: 'run-done',
    no_match: 'run-nomatch', failed: 'run-failed',
  }[status] ?? 'run-running'
}
function runPillText(status) {
  return {
    queued: 'Queued', running: 'Analysing…',
    awaiting_approval: 'Review ready', completed: 'Done',
    no_match: 'No match', failed: 'Failed',
  }[status] ?? status
}

// ── Run status banner ─────────────────────────────────────────────────────────
function RunStatusBanner({ run }) {
  const config = {
    queued:            { cls: 'run-banner-queued',    icon: <CircleDot size={15} />, msg: 'Workflow queued — starting soon…' },
    running:           { cls: 'run-banner-running',   icon: <CircleDot size={15} />, msg: 'Analysing candidates — this may take a moment…' },
    awaiting_approval: { cls: 'run-banner-approval',  icon: <Sparkles  size={15} />, msg: 'Recommendations ready. Review and approve or reject a candidate below.' },
    completed:         { cls: 'run-banner-done',      icon: <CheckCircle2 size={15} />, msg: 'Assignment has been committed.' },
    no_match:          { cls: 'run-banner-nomatch',   icon: <XCircle  size={15} />, msg: 'No candidate met the skill and availability requirements.' },
    failed:            { cls: 'run-banner-failed',    icon: <XCircle  size={15} />, msg: `Workflow failed${run.error ? ': ' + run.error : '.'}` },
  }
  const c = config[run.status] ?? config.running
  return (
    <div className={`run-banner ${c.cls}`} role="status">
      {c.icon}{c.msg}
    </div>
  )
}

// ── Recommendation card ───────────────────────────────────────────────────────
function RecommendationCard({ rec, rank, taskId, canAct, onApprove, onReject }) {
  const [busy, setBusy] = useState(null) // 'approve' | 'reject' | null

  async function handleApprove() {
    setBusy('approve')
    await onApprove(rec.id, taskId)
    setBusy(null)
  }
  async function handleReject() {
    setBusy('reject')
    await onReject(rec.id, taskId)
    setBusy(null)
  }

  const scorePercent = Math.round(rec.score ?? 0)
  const scoreColor = scorePercent >= 75 ? 'score-high' : scorePercent >= 50 ? 'score-mid' : 'score-low'

  return (
    <article className={`rec-card${rank === 1 ? ' rec-card-top' : ''}`}>
      <header className="rec-card-header">
        <span className="rec-rank">#{rank}</span>
        <span className="rec-name">{rec.candidate_name ?? 'Candidate'}</span>
        <span className={`rec-score ${scoreColor}`}>
          <span className="rec-score-bar" style={{ '--pct': `${scorePercent}%` }} />
          {scorePercent}
        </span>
      </header>

      {rec.reasons?.length > 0 && (
        <ul className="rec-reasons">
          {rec.reasons.map((r, i) => (
            <li key={i}>
              <span className={rec.eligible ? 'reason-ok' : 'reason-warn'}>
                {rec.eligible ? <Check size={11} /> : <CircleAlert size={11} />}
              </span>
              {r}
            </li>
          ))}
        </ul>
      )}

      {canAct && (
        <div className="rec-actions">
          <button
            className="button button-approve"
            onClick={handleApprove}
            disabled={!!busy}
            aria-label={`Approve ${rec.candidate_name}`}
          >
            {busy === 'approve' ? 'Approving…' : <><ThumbsUp size={13} />Approve</>}
          </button>
          <button
            className="button button-reject"
            onClick={handleReject}
            disabled={!!busy}
            aria-label={`Reject ${rec.candidate_name}`}
          >
            {busy === 'reject' ? 'Rejecting…' : <><ThumbsDown size={13} />Reject</>}
          </button>
        </div>
      )}
    </article>
  )
}

// ── Teams view ────────────────────────────────────────────────────────────────
function TeamsView({ teams, loading, onCreate }) {
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">WORKSPACE / PEOPLE</span>
          <h1>Your teams</h1>
          <p>Organize work into teams inside your workspace.</p>
        </div>
        <button className="button button-primary" onClick={onCreate}><Plus size={16} />New team</button>
      </div>
      {loading
        ? <div className="team-grid"><div className="team-card skeleton" /><div className="team-card skeleton" /></div>
        : teams.length
          ? <div className="team-grid">
              {teams.map((team, index) => (
                <article className="team-card" key={team.id}>
                  <span className={`team-symbol team-symbol-${index % 4}`}><UsersRound size={20} /></span>
                  <span className="team-code">TEAM / {String(index + 1).padStart(2, '0')}</span>
                  <h2>{team.name}</h2>
                  <div className="team-meta">
                    <span><UsersRound size={14} />{team.member_count} members</span>
                    <span><ListChecks size={14} />{team.task_count} tasks</span>
                  </div>
                </article>
              ))}
            </div>
          : <section className="panel">
              <EmptyState title="Build your first team" detail="Teams give your tasks a home and help keep the workload organized." action="Create team" onAction={onCreate} />
            </section>
      }
    </>
  )
}

// ── Shared small components ───────────────────────────────────────────────────
function EmptyState({ title, detail, action, onAction }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><ListChecks size={20} /></span>
      <strong>{title}</strong>
      <p>{detail}</p>
      <button className="button button-secondary" onClick={onAction}><Plus size={14} />{action}</button>
    </div>
  )
}

function LoadingRows() {
  return <div className="loading-rows" aria-label="Loading"><i /><i /><i /></div>
}

function FormError({ children }) {
  return <div className="form-error" role="alert"><CircleAlert size={15} />{children}</div>
}

// ── Modals ────────────────────────────────────────────────────────────────────
function TeamModal({ onClose, onSubmit }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    try { await onSubmit(name.trim()) } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return (
    <Modal eyebrow="WORKSPACE SETUP" title="Create a team" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <p className="modal-intro">Give this group a clear home for shared work.</p>
        <Field label="Team name">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Product engineering" maxLength="120" required />
        </Field>
        {error && <FormError>{error}</FormError>}
        <ModalActions busy={busy} submitLabel="Create team" onClose={onClose} />
      </form>
    </Modal>
  )
}

function TaskModal({ teams, onClose, onSubmit }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    const values = new FormData(e.currentTarget)
    const deadline = values.get('deadline')
    const hours = values.get('estimated_hours')
    const payload = {
      team_id: values.get('team_id'),
      title: values.get('title'),
      description: values.get('description'),
      priority: values.get('priority'),
      deadline: deadline ? new Date(`${deadline}T23:59:00`).toISOString() : null,
      estimated_hours: hours ? Number(hours) : null,
    }
    try { await onSubmit(payload) } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return (
    <Modal eyebrow="ADD TO THE QUEUE" title="Create a task" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Task name"><input name="title" autoFocus placeholder="Ship the reporting dashboard" maxLength="200" required /></Field>
          <Field label="Team">
            <select name="team_id" required defaultValue="">
              <option value="" disabled>Select a team</option>
              {teams.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select name="priority" defaultValue="MEDIUM">
              {PRIORITIES.map((p) => <option key={p} value={p}>{label(p)}</option>)}
            </select>
          </Field>
          <Field label="Due date"><input name="deadline" type="date" min={new Date().toISOString().slice(0, 10)} /></Field>
          <Field label="Estimate (hours)"><input name="estimated_hours" type="number" min="0.25" step="0.25" placeholder="e.g. 6" /></Field>
          <Field label="Description"><textarea name="description" placeholder="What needs to be done?" maxLength="20000" rows="3" required /></Field>
        </div>
        {error && <FormError>{error}</FormError>}
        <ModalActions busy={busy} submitLabel="Add to queue" onClose={onClose} />
      </form>
    </Modal>
  )
}

function ModalActions({ busy, submitLabel, onClose }) {
  return (
    <div className="modal-actions">
      <button className="button button-quiet" type="button" onClick={onClose}>Cancel</button>
      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? 'Saving…' : submitLabel}<ArrowRight size={15} />
      </button>
    </div>
  )
}

function Modal({ eyebrow, title, onClose, children }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal-heading">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog"><X size={17} /></button>
        </header>
        {children}
      </section>
    </div>
  )
}
