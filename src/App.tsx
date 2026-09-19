import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, BarChart3, Bell,
  BookOpen, CalendarDays, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown,
  CircleDollarSign, Clock3, Copy, ExternalLink, Fingerprint, KeyRound, LayoutDashboard, LoaderCircle,
  LockKeyhole, LogOut, Menu, MoreHorizontal, Plus, Search, Settings2, ShieldCheck, ShieldOff,
  Sparkles, Users, Wallet, X, Zap } from 'lucide-react'
import { apiBase, configError, createEmployee, demo, getDashboard, supabase, updateEmployee, updateVpnSettings } from './api'
import { makeDemo } from './data'
import type { Dashboard, Employee, Log } from './data'

type Page = 'overview' | 'employees' | 'employeeUsage' | 'activity' | 'settings' | 'guide'
const nav = [
  { id: 'overview', title: 'Обзор', icon: LayoutDashboard },
  { id: 'employees', title: 'Сотрудники и ключи', icon: Users },
  { id: 'employeeUsage', title: 'Использование сотрудников', icon: Fingerprint },
  { id: 'activity', title: 'История запросов', icon: Activity },
  { id: 'settings', title: 'Настройки', icon: Settings2 },
] as const
const money = (n: number, digits = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)
const number = (n: number) => new Intl.NumberFormat('ru-RU').format(n)
const compact = (n: number) => new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const initials = (name: string) => name.split(' ').slice(0, 2).map(x => x[0]).join('')
const dateLabel = (s: string, time = false) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'short', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}), timeZone: 'UTC' })
const dateTimeLabel = (s: string) => new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
const durationLabel = (ms: number) => ms < 1000 ? `${number(ms)} мс` : `${(ms / 1000).toFixed(2)} с`
const modelLabel = (model: string) => model.replace('claude-sonnet-4-20250514', 'Claude Sonnet 4').replace('gpt-4.1-mini', 'GPT-4.1 mini').replace('gpt-4.1', 'GPT-4.1')

function Logo({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'small' : ''}`}><span className="brand-mark"><BarChart3 size={22} strokeWidth={2.6} /></span>{!small && <span>AI Cost<span className="brand-light">Tracker</span></span>}</div>
}
function Provider({ name, label = false }: { name: string; label?: boolean }) {
  return <span className="provider-wrap"><span className={`provider-icon ${name}`}>{name === 'openai' ? <Sparkles size={14} /> : 'A'}</span>{label && (name === 'openai' ? 'OpenAI' : 'Anthropic')}</span>
}
function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const el = ref.current!; el.showModal(); return () => el.close() }, [])
  return <dialog ref={ref} className="modal" onCancel={close} onClick={e => { if (e.target === e.currentTarget) close() }}>
    <div className="modal-head"><h2>{title}</h2><button className="icon-button" aria-label="Закрыть" onClick={close}><X size={19} /></button></div>{children}
  </dialog>
}
function Chart({ logs, days }: { logs: Log[]; days: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const points = useMemo(() => {
    const values = Array.from({ length: days }, (_, i) => {
      const date = new Date(); date.setUTCDate(date.getUTCDate() - days + i + 1)
      return { date: date.toISOString().slice(0, 10), openai: 0, anthropic: 0 }
    })
    for (const log of logs) { const p = values.find(x => x.date === log.created_at.slice(0, 10)); if (p) p[log.provider === 'openai' ? 'openai' : 'anthropic'] += log.cost_usd }
    return values
  }, [logs, days])
  const max = Math.max(.5, Math.ceil(Math.max(...points.map(p => Math.max(p.openai, p.anthropic))) * 2) / 2)
  const w = 760, h = 205, bottom = 176, left = 48, right = 745
  const px = (i: number) => left + i / (points.length - 1) * (right - left)
  const py = (v: number) => bottom - (v / max) * 151
  const line = (type: 'total' | 'openai') => points.map((p, i) => `${i ? 'L' : 'M'}${px(i)},${py(type === 'total' ? p.anthropic : p.openai)}`).join(' ')
  const area = (type: 'total' | 'openai') => `${line(type)} L${right},${bottom} L${left},${bottom} Z`
  return <div className="chart-container">
    <svg className="expense-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Расходы по дням за ${days} дней, в долларах`} onMouseLeave={() => setHover(null)}>
      <defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#9a83ee" stopOpacity=".26" /><stop offset="100%" stopColor="#9a83ee" stopOpacity=".025" /></linearGradient></defs>
      {[0, 1, 2, 3].map(i => <g key={i}><line x1={left} x2={right} y1={py(max * i / 3)} y2={py(max * i / 3)} stroke="#eeedf2" strokeDasharray="4 4" /><text x={left - 13} y={py(max * i / 3) + 4} textAnchor="end">${Number((max * i / 3).toFixed(1))}</text></g>)}
      <path d={area('total')} fill="url(#chart-fill)" /><path d={area('openai')} fill="#6c54dc" opacity=".05" />
      <path d={line('total')} fill="none" stroke="#b59aea" strokeWidth="2" strokeLinejoin="round" />
      <path d={line('openai')} fill="none" stroke="#7859dc" strokeWidth="2.7" strokeLinejoin="round" />
      {points.map((p, i) => <g key={p.date}>
        {(i % Math.ceil(days / 6) === 0 || i === days - 1) && <text x={px(i)} y={h - 6} textAnchor={i === days - 1 ? 'end' : 'middle'}>{dateLabel(p.date)}</text>}
        <rect x={px(i) - (right - left) / days / 2} y="10" width={(right - left) / days + 2} height={bottom - 10} fill="transparent" onMouseEnter={() => setHover(i)} />
      </g>)}
      {hover !== null && <g pointerEvents="none"><line x1={px(hover)} x2={px(hover)} y1="20" y2={bottom} stroke="#9a83ee" strokeDasharray="3 3" /><circle cx={px(hover)} cy={py(points[hover].anthropic)} r="4" fill="#b59aea" stroke="white" strokeWidth="2" /><circle cx={px(hover)} cy={py(points[hover].openai)} r="4" fill="#7859dc" stroke="white" strokeWidth="2" /></g>}
    </svg>
    {hover !== null && <div className="chart-tooltip" style={{ left: `${Math.min(75, Math.max(8, px(hover) / w * 100))}%` }}>{dateLabel(points[hover].date)}<strong>{money(points[hover].openai + points[hover].anthropic)}</strong><span>OpenAI {money(points[hover].openai)} · Anthropic {money(points[hover].anthropic)}</span></div>}
  </div>
}

function ipv4ToInt(ip: string) { const p = ip.split('.').map(Number); return p.length === 4 && p.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : null }
function inRange(cidr: string, range: string) {
  const [ip] = cidr.split('/'); const [net, bits] = range.split('/'); const a = ipv4ToInt(ip), n = ipv4ToInt(net), len = Number(bits)
  if (a === null || n === null || !(len >= 0 && len <= 32)) return true // IPv6/unknown: the server validates
  const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0
  return ((a & mask) >>> 0) === ((n & mask) >>> 0)
}

export default function App() {
  const [page, setPage] = useState<Page>('overview')
  const [data, setData] = useState<Dashboard | null>(() => demo ? makeDemo() : null)
  const [signedIn, setSignedIn] = useState(demo)
  const [authReady, setAuthReady] = useState(demo || configError)
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [days, setDays] = useState(30)
  const [query, setQuery] = useState('')
  const [department, setDepartment] = useState('all')
  const [logProvider, setLogProvider] = useState('all')
  const [logStatus, setLogStatus] = useState('all')
  const [logPage, setLogPage] = useState(0)
  const [selectedUserId, setSelectedUserId] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [modal, setModal] = useState<'create' | 'vpnRange' | 'notifications' | null>(null)
  const [editUser, setEditUser] = useState<Employee | null>(null)
  const [createdKey, setCreatedKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [updated, setUpdated] = useState<Date | null>(demo ? new Date() : null)

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data: auth }) => { setSignedIn(Boolean(auth.session)); setEmail(auth.session?.user.email || ''); setAuthReady(true) })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { setSignedIn(Boolean(session)); setEmail(session?.user.email || ''); if (!session) setData(null) })
    return () => listener.subscription.unsubscribe()
  }, [])
  useEffect(() => {
    if (demo || !signedIn) return
    let cancelled = false
    async function refresh() {
      setLoading(true)
      try { const snapshot = await getDashboard(); if (!cancelled) { setData(snapshot); setError(''); setUpdated(new Date()) } }
      catch (e) { if (!cancelled) setError((e as Error).message) }
      finally { if (!cancelled) setLoading(false) }
    }
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 15000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [signedIn])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 4000); return () => clearTimeout(t) }, [toast])
  useEffect(() => { setQuery(''); setLogPage(0); setMobileNav(false); document.title = `AI Cost Tracker — ${nav.find(x => x.id === page)?.title || 'Подключение'}` }, [page])
  useEffect(() => setLogPage(0), [query, logProvider, logStatus, days])

  const periodStart = new Date(); periodStart.setUTCDate(periodStart.getUTCDate() - days + 1); periodStart.setUTCHours(0, 0, 0, 0)
  const logs = data?.logs.filter(l => new Date(l.created_at) >= periodStart) || []
  const total = logs.reduce((s, l) => s + l.cost_usd, 0)
  const tokens = logs.reduce((s, l) => s + l.input_tokens + l.output_tokens, 0)
  const users = data?.users || []
  const active = users.filter(u => logs.some(l => l.user_id === u.id)).length
  const inactive = users.filter(u => u.status === 'active' && !logs.some(l => l.user_id === u.id))
  const budget = users.reduce((s, u) => s + u.monthly_limit, 0)
  const spent = users.reduce((s, u) => s + u.monthly_spend, 0)
  const reserved = users.reduce((s, u) => s + u.reserved, 0)
  const usagePercent = budget ? spent / budget * 100 : 0
  const byProvider = ['openai', 'anthropic'].map(provider => ({ provider, total: logs.filter(l => l.provider === provider).reduce((s, l) => s + l.cost_usd, 0) }))
  const topModels = Array.from(new Set(logs.map(l => l.model))).map(model => ({ model, total: logs.filter(l => l.model === model).reduce((s, l) => s + l.cost_usd, 0) })).sort((a, b) => b.total - a.total)
  const filteredUsers = users.filter(u => `${u.name} ${u.email}`.toLowerCase().includes(query.toLowerCase()) && (department === 'all' || u.department === department))
  const filteredLogs = logs.filter(l => (logProvider === 'all' || l.provider === logProvider) && (logStatus === 'all' || l.status === logStatus) && `${users.find(u => u.id === l.user_id)?.name} ${l.model} ${l.id}`.toLowerCase().includes(query.toLowerCase()))
  const selectedEmployee = users.find(u => u.id === selectedUserId) || users[0]
  const selectedEmployeeLogs = selectedEmployee ? logs.filter(l => l.user_id === selectedEmployee.id) : []
  const selectedEmployeeTokens = selectedEmployeeLogs.reduce((sum, log) => sum + log.input_tokens + log.output_tokens, 0)
  const selectedEmployeeCost = selectedEmployeeLogs.reduce((sum, log) => sum + log.cost_usd, 0)
  const selectedEmployeeLatency = selectedEmployeeLogs.length ? selectedEmployeeLogs.reduce((sum, log) => sum + log.latency_ms, 0) / selectedEmployeeLogs.length : 0
  const selectedEmployeeModels = Array.from(new Set(selectedEmployeeLogs.map(log => log.model))).map(model => {
    const modelLogs = selectedEmployeeLogs.filter(log => log.model === model)
    return { model, provider: modelLogs[0].provider, requests: modelLogs.length, tokens: modelLogs.reduce((sum, log) => sum + log.input_tokens + log.output_tokens, 0), cost: modelLogs.reduce((sum, log) => sum + log.cost_usd, 0) }
  }).sort((a, b) => b.requests - a.requests)
  const attention = inactive.length + users.filter(u => u.monthly_limit > 0 && u.monthly_spend / u.monthly_limit >= .8).length + (reserved > 0 ? 1 : 0)
  const go = (p: Page) => setPage(p)
  const notify = (text: string) => setToast(text)

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); notify('Скопировано в буфер обмена') } catch { notify('Не удалось скопировать. Выделите и скопируйте текст вручную.') }
  }
  async function changeUser(user: Employee, patch: { status?: 'active' | 'quarantined'; vpn_cidr?: string; monthly_limit?: number }) {
    setBusy(true); setFormError('')
    try {
      if (patch.vpn_cidr && data?.settings.vpn_cidr && !inRange(patch.vpn_cidr, data.settings.vpn_cidr)) throw new Error(`VPN IP сотрудника должен входить в диапазон компании ${data.settings.vpn_cidr}.`)
      const result = demo ? { ...user, ...patch } : await updateEmployee(user.id, patch)
      setData(d => d ? { ...d, users: d.users.map(u => u.id === user.id ? result : u) } : d)
      setEditUser(null)
      notify(patch.status ? (patch.status === 'quarantined' ? 'Ключ отключён. Новые запросы заблокированы.' : 'Доступ сотрудника восстановлен') : 'Настройки сотрудника обновлены')
    } catch (e) { const message = (e as Error).message; setFormError(message); notify(message) } finally { setBusy(false) }
  }
  async function addUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFormError('')
    const form = new FormData(event.currentTarget)
    const body = { name: String(form.get('name')).trim(), email: String(form.get('email')).trim(), department: String(form.get('department')).trim(), monthly_limit: Number(form.get('limit')) }
    try {
      if (users.some(u => u.email.toLowerCase() === body.email.toLowerCase())) throw new Error('Сотрудник с таким email уже существует.')
      const key = `act_demo_${crypto.randomUUID().replaceAll('-', '')}`
      const result = demo ? { key, user: { ...body, id: crypto.randomUUID(), status: 'active' as const, key_prefix: key.slice(0, 12), monthly_spend: 0, reserved: 0, last_active: null, created_at: new Date().toISOString() } } : await createEmployee(body)
      setData(d => d ? { ...d, users: [...d.users, result.user] } : d)
      setCreatedKey(result.key)
    } catch (e) { setFormError((e as Error).message) } finally { setBusy(false) }
  }
  async function saveVpnRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFormError('')
    const vpn_cidr = String(new FormData(event.currentTarget).get('vpn_cidr')).trim()
    try {
      const settings = demo ? { vpn_cidr } : await updateVpnSettings(vpn_cidr)
      setData(current => current ? { ...current, settings } : current)
      setModal(null); notify('Диапазон VPN обновлён')
    } catch (e) { const message = (e as Error).message; setFormError(message); notify(message) } finally { setBusy(false) }
  }
  function exportCsv() {
    const exportLogs = page === 'activity' ? filteredLogs : page === 'employeeUsage' ? selectedEmployeeLogs : logs
    const rows = [['Время UTC', 'Сотрудник', 'Провайдер', 'Модель', 'Входные токены', 'Выходные токены', 'Стоимость USD', 'Длительность, мс', 'Статус'], ...exportLogs.map(l => [l.created_at, users.find(u => u.id === l.user_id)?.name || l.user_id, l.provider, l.model, l.input_tokens, l.output_tokens, l.cost_usd.toFixed(8), l.latency_ms, l.status])]
    const csv = '\uFEFF' + rows.map(row => row.map(value => { const text = String(value); return `"${(/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"` }).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const a = document.createElement('a'); a.href = url; a.download = `ai-costs-${demo ? 'demo-' : ''}${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    notify(`Экспортировано запросов: ${number(exportLogs.length)}`)
  }

  if (configError) return <div className="login-screen"><div className="login-card"><Logo /><h1>Проверьте настройки</h1><p>В .env должны быть указаны обе переменные: VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY. После изменения перезапустите Vite.</p></div></div>
  if (!authReady) return <div className="login-screen"><LoaderCircle className="spin" /></div>
  if (!signedIn) return <div className="login-screen"><div className="login-card"><Logo /><div className="eyebrow">РАСХОДЫ НА ИИ ПОД КОНТРОЛЕМ</div><h1>С возвращением</h1><p>Войдите в рабочее пространство вашей команды.</p><form onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError(''); const f = new FormData(e.currentTarget)
    try { const result = await supabase!.auth.signInWithPassword({ email: String(f.get('email')), password: String(f.get('password')) }); if (result.error) setError('Не удалось войти. Проверьте email и пароль.') } catch { setError('Нет связи с сервером авторизации.') } finally { setBusy(false) }
  }}><label>Рабочий email<input name="email" type="email" placeholder="you@company.com" autoComplete="username" required /></label><label>Пароль<input name="password" type="password" autoComplete="current-password" required /></label>{error && <p role="alert" className="form-error">{error}</p>}<button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <LockKeyhole size={16} />}Войти в дашборд</button></form><div className="privacy-note"><ShieldCheck size={15} />Доступ только для администраторов</div></div></div>

  return <div className="app-shell">
    {mobileNav && <button className="nav-scrim" aria-label="Закрыть меню" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <Logo />
      <button className="workspace-switch" onClick={() => go('settings')}><span className="workspace-icon">a<span>c</span></span><span><strong>{demo ? 'Acme Studio' : 'Моя компания'}</strong><small>Рабочее пространство</small></span><ChevronsUpDown size={14} /></button>
      <div className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <nav aria-label="Основная навигация">{nav.map(item => <button key={item.id} className={`nav-link ${page === item.id ? 'active' : ''}`} onClick={() => go(item.id)}><item.icon size={19} /><span>{item.title}</span>{item.id === 'employees' && <span className="nav-count">{users.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="security-card"><span className="security-icon"><ShieldCheck size={21} /></span><strong>Ключи под защитой</strong><p>Корпоративные API-ключи<br />остаются на вашем сервере.</p><button onClick={() => go('guide')}>Как это работает <ArrowUpRight size={14} /></button></div>
        <button className={`nav-link ${page === 'guide' ? 'active' : ''}`} onClick={() => go('guide')}><BookOpen size={18} />Подключение и помощь<ArrowUpRight size={14} /></button>
        <div className="profile"><span className="avatar profile-avatar">{demo ? 'АК' : initials(email)}</span><span><strong>{demo ? 'Александр Козлов' : email.split('@')[0]}</strong><small>Администратор</small></span>{!demo && <button className="icon-button" aria-label="Выйти" onClick={async () => { const result = await supabase!.auth.signOut(); if (result.error) notify('Не удалось выйти. Повторите попытку.') }}><LogOut size={16} /></button>}<span className="profile-online" /></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Открыть меню" onClick={() => setMobileNav(true)}><Menu size={21} /></button><span>Рабочее пространство</span><ChevronRight size={14} /><strong>{nav.find(n => n.id === page)?.title || 'Подключение'}</strong></div><div className="topbar-right"><span className={`connection ${error ? 'offline' : ''}`}><i />{demo ? 'Деморежим' : error ? 'Ошибка подключения' : loading ? 'Обновление…' : 'Подключено'}</span><span className="topbar-divider" /><button className="icon-button notifications" aria-label="Уведомления" onClick={() => setModal('notifications')}><Bell size={19} />{attention > 0 && <i />}</button><span className="avatar mini-avatar">{demo ? 'АК' : initials(email)}</span></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">ВАШ ИИ. ВАШ КОНТРОЛЬ.</div><h1>{page === 'overview' ? 'Обзор расходов' : page === 'employeeUsage' && selectedEmployee ? `Использование: ${selectedEmployee.name}` : nav.find(n => n.id === page)?.title || 'Подключение к прокси'}<span className="heading-dot">.</span></h1><p>{page === 'overview' ? 'Всё о расходах на ИИ — в одном месте.' : page === 'employees' ? 'Управляйте доступом, виртуальными ключами и бюджетами команды.' : page === 'employeeUsage' ? 'Модели, токены, стоимость и время каждого запроса сотрудника.' : page === 'activity' ? 'Финансовые метаданные запросов. Без промптов и ответов.' : page === 'settings' ? 'Провайдеры, тарифы и безопасность рабочего пространства.' : 'Несколько шагов, чтобы начать контролировать расходы.'}</p></div>
          <div className="heading-actions">{(page === 'overview' || page === 'activity' || page === 'employeeUsage') && <><label className="select-button"><CalendarDays size={16} /><select aria-label="Период" value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>Последние 7 дней</option><option value={30}>Последние 30 дней</option><option value={60}>Последние 60 дней</option></select><ChevronDown size={14} /></label><button className="button" onClick={exportCsv} disabled={!data}><ArrowDownToLine size={16} />Экспорт</button></>}{page === 'employees' && <button className="button" onClick={() => { setModal('vpnRange'); setFormError('') }}><LockKeyhole size={16} />Диапазон VPN</button>}{page === 'employees' && <button className="button primary" onClick={() => { setModal('create'); setCreatedKey(''); setFormError('') }}><Plus size={17} />Добавить сотрудника</button>}</div>
        </div>
        {demo && <div className="demo-notice"><span><span className="demo-tag">DEMO</span>Вы в демопространстве. Данные и ключи тестовые; изменения сохраняются до перезагрузки.</span><button onClick={() => go('guide')}>Подключить проект <ArrowRight size={14} /></button></div>}
        {error && <div className="error-banner" role="alert">{error} {data && 'Показаны последние загруженные данные.'}</div>}
        {!data && <div className="empty-state">{loading ? <><LoaderCircle className="spin" /><h3>Загружаем рабочее пространство…</h3></> : <><ShieldOff /><h3>Данные пока недоступны</h3><p>Проверьте подключение backend и права администратора.</p></>}</div>}
        {data?.truncated && <div className="error-banner">Достигнут лимит выборки. Отображаемые итоги и экспорт включают только загруженные записи.</div>}
        {data && page === 'overview' && <>
          <section className="stats-grid" aria-label="Основные показатели">
            <Stat title="Расходы за период" value={money(total)} icon={<CircleDollarSign size={19} />}><span className="stat-neutral">{days} дней</span><span>по всем провайдерам</span></Stat>
            <Stat title="Запросы к ИИ" value={number(logs.length)} icon={<Zap size={19} />}><span className="stat-green"><CheckCheck size={13} />{logs.length ? ((logs.filter(l => l.status === 'success').length / logs.length) * 100).toFixed(1) : '0'}%</span><span>успешных запросов</span></Stat>
            <Stat title="Активные сотрудники" value={<>{active}<span className="stat-denominator"> / {users.length}</span></>} icon={<Users size={19} />}><span className="avatar-stack">{users.slice(0, 3).map((u, i) => <span key={u.id} className={`avatar tone-${i}`}>{initials(u.name)}</span>)}</span><span>{inactive.length ? `${inactive.length} без запросов за период` : 'Вся команда на связи'}</span></Stat>
            <Stat title="Использовано токенов" value={compact(tokens)} icon={<Fingerprint size={19} />}><span className="stat-neutral">{money(logs.length ? total / logs.length : 0, 4)}</span><span>в среднем за запрос</span></Stat>
          </section>
          <div className="analytics-grid"><section className="panel expense-panel"><div className="panel-heading"><div><h2>Динамика расходов</h2><p>Ежедневные расходы на API нейросетей</p></div><span className="unit-badge">USD</span></div><div className="chart-summary"><strong>{money(total)}</strong><span><span className="legend-dot purple" />OpenAI<span className="legend-dot lilac" />Anthropic</span></div><Chart logs={logs} days={days} /><div className="chart-footer"><span><i className="live-dot" />{demo ? 'Демонстрационные данные' : 'Автообновление каждые 15 сек.'}</span><span>Время в UTC</span></div></section>
          <section className="panel provider-panel"><div className="panel-heading"><div><h2>По провайдерам</h2><p>Распределение расходов</p></div><div className="icon-subtle"><MoreHorizontal size={19} /></div></div><div className="donut-wrap"><div className="donut" style={{ background: total ? `conic-gradient(#7959de 0% ${byProvider[0].total / total * 100}%, #c7b4ee ${byProvider[0].total / total * 100}% 100%)` : '#eeeaf6' }}><div><span>Всего расходов</span><strong>{money(total)}</strong><small>за {days} дней</small></div></div></div><div className="provider-legend">{byProvider.map(p => <div key={p.provider}><Provider name={p.provider} label /><span>{total ? Math.round(p.total / total * 100) : 0}%</span><strong>{money(p.total)}</strong></div>)}</div></section></div>
          <div className="insight-grid"><section className="budget-card"><div className="budget-icon"><Wallet size={21} /></div><div className="budget-content"><div><h3>Месячный бюджет</h3><span><strong>{money(spent)}</strong> / {money(budget, 0)}</span></div><div className="progress-track"><span style={{ width: `${Math.min(100, usagePercent)}%`, background: usagePercent >= 90 ? '#e69a37' : undefined }} /></div><div className="budget-caption"><span>Использовано {usagePercent.toFixed(1)}%{reserved > 0 ? ` · В резерве ${money(reserved)}` : ''}</span><button onClick={() => go('employees')}>Настроить лимиты <ArrowRight size={13} /></button></div></div></section>
          <section className="insight-card"><span className="insight-icon"><Sparkles size={21} /></span><div><div className="insight-title"><h3>Возможность оптимизации</h3><span>ИНСАЙТ</span></div><p>{inactive.length ? <>{inactive.length} сотрудников не используют ИИ. Проверьте распределение <strong>{money(inactive.reduce((s, u) => s + u.monthly_limit, 0), 0)}</strong> лимитов.</> : 'Сравните расходы по моделям и подберите подходящие для задач команды.'}</p></div><button className="icon-button" aria-label="Посмотреть возможности оптимизации" onClick={() => go('employees')}><ArrowUpRight size={20} /></button></section></div>
          <div className="lower-grid"><section className="panel team-panel"><div className="panel-heading"><div><h2>Использование ключей <span className="count-badge">{users.length}</span></h2><p>Когда ключи созданы, использованы и сколько запросов выполнили</p></div><button className="text-button" onClick={() => go('employees')}>Все сотрудники <ArrowRight size={14} /></button></div><EmployeeTable users={[...users].sort((a, b) => (b.last_active || '').localeCompare(a.last_active || '')).slice(0, 5)} logs={logs} compact onEdit={u => { setEditUser(u); setFormError('') }} onOpenUsage={u => { setSelectedUserId(u.id); go('employeeUsage') }} /></section>
          <section className="panel models-panel"><div className="panel-heading"><div><h2>Популярные модели</h2><p>По расходам за период</p></div><BarChart3 size={17} className="muted" /></div><div className="model-list">{topModels.slice(0, 4).map((m, i) => <div className="model-row" key={m.model}><div><span><Provider name={m.model.startsWith('claude') ? 'anthropic' : 'openai'} />{modelLabel(m.model)}</span><strong>{money(m.total)}</strong></div><div className="model-bar"><span style={{ width: `${total ? m.total / total * 100 : 0}%`, background: ['#7b5ce0', '#aa8be9', '#cec0ec', '#ddd5ed'][i] }} /></div><small>{total ? (m.total / total * 100).toFixed(1) : 0}% от всех расходов</small></div>)}{!topModels.length && <p className="empty-inline">Расходов пока нет</p>}</div><button className="model-footer" onClick={() => go('activity')}>Открыть историю запросов <ArrowRight size={14} /></button></section></div>
          <section className="privacy-footer"><ShieldCheck size={15} /><span>Privacy first. Сохраняем финансовые метаданные, без текстов запросов.</span><span className="last-updated">Обновлено в {updated?.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span></section>
        </>}
        {data && page === 'employees' && <><div className="small-stats"><span><Users size={17} />{users.length} сотрудников</span><span><span className="live-dot" />{users.filter(u => u.status === 'active').length} ключей активно</span><span><ShieldOff size={16} />{users.filter(u => u.status === 'quarantined').length} в карантине</span><span><LockKeyhole size={16} />{users.filter(u => u.vpn_cidr).length} VPN-адресов настроено</span></div><section className="panel"><div className="table-toolbar"><label className="search-field"><Search size={17} /><input placeholder="Имя, email или VPN IP…" value={query} onChange={e => setQuery(e.target.value)} /></label><label className="select-button"><select aria-label="Отдел" value={department} onChange={e => setDepartment(e.target.value)}><option value="all">Все отделы</option>{Array.from(new Set(users.map(u => u.department))).map(d => <option key={d}>{d}</option>)}</select><ChevronDown size={14} /></label></div><EmployeeTable users={filteredUsers} logs={logs} onEdit={u => { setEditUser(u); setFormError('') }} onOpenUsage={u => { setSelectedUserId(u.id); go('employeeUsage') }} onToggle={u => void changeUser(u, { status: u.status === 'active' ? 'quarantined' : 'active' })} busy={busy} /><div className="table-bottom">{filteredUsers.length} из {users.length} сотрудников<span>VPN-адрес проверяется при каждом запросе</span></div></section><div className="info-strip"><KeyRound size={18} /><p>Сервис не выдаёт VPN-адреса. Он только проверяет, что запрос с виртуальным ключом пришёл точно с настроенного IP сотрудника. Полный виртуальный ключ показывается один раз.</p></div></>}
        {data && page === 'employeeUsage' && (selectedEmployee ? <>
          <section className="panel employee-usage-hero"><div className="employee-usage-profile"><span className="avatar tone-0">{initials(selectedEmployee.name)}</span><div><h2>{selectedEmployee.name}</h2><p>{selectedEmployee.email} · {selectedEmployee.department}</p><span><code className="key-prefix">{selectedEmployee.key_prefix}••••</code><code className="vpn-address">{selectedEmployee.vpn_cidr || 'VPN не настроен'}</code><span className={`status ${selectedEmployee.status}`}><i />{selectedEmployee.status === 'active' ? 'Активен' : 'Карантин'}</span></span></div></div><label className="employee-picker"><span>Сотрудник</span><span className="select-button"><Users size={16} /><select aria-label="Сотрудник" value={selectedEmployee.id} onChange={e => setSelectedUserId(e.target.value)}>{users.map(user => <option value={user.id} key={user.id}>{user.name}</option>)}</select><ChevronDown size={14} /></span></label></section>
          <section className="stats-grid employee-usage-stats" aria-label={`Показатели сотрудника ${selectedEmployee.name}`}>
            <Stat title="Запросы к ИИ" value={number(selectedEmployeeLogs.length)} icon={<Zap size={19} />}><span className="stat-neutral">{days} дней</span><span>{selectedEmployeeLogs.filter(log => log.status === 'success').length} успешных</span></Stat>
            <Stat title="Всего токенов" value={compact(selectedEmployeeTokens)} icon={<Fingerprint size={19} />}><span className="stat-neutral">{compact(selectedEmployeeLogs.reduce((sum, log) => sum + log.output_tokens, 0))}</span><span>выходных токенов</span></Stat>
            <Stat title="Стоимость" value={money(selectedEmployeeCost)} icon={<CircleDollarSign size={19} />}><span className="stat-neutral">{money(selectedEmployeeLogs.length ? selectedEmployeeCost / selectedEmployeeLogs.length : 0, 4)}</span><span>за запрос</span></Stat>
            <Stat title="Среднее время ответа" value={durationLabel(selectedEmployeeLatency)} icon={<Clock3 size={19} />}><span className="stat-neutral">UTC</span><span>{selectedEmployee.last_active ? `последний ${dateLabel(selectedEmployee.last_active, true)}` : 'ещё не использован'}</span></Stat>
          </section>
          <section className="panel employee-models-panel"><div className="panel-heading"><div><h2>Использованные модели</h2><p>Запросы, токены и стоимость по моделям за выбранный период</p></div><BarChart3 size={18} className="muted" /></div><div className="table-scroll"><table><thead><tr><th>Модель</th><th>Запросы</th><th>Токены</th><th>Стоимость</th><th>Доля запросов</th></tr></thead><tbody>{selectedEmployeeModels.map(item => <tr key={item.model}><td><span className="model-cell"><Provider name={item.provider} />{modelLabel(item.model)}</span></td><td className="tabular">{number(item.requests)}</td><td className="tabular">{number(item.tokens)}</td><td className="tabular"><strong>{money(item.cost, 5)}</strong></td><td><div className="model-share"><div><i style={{ width: `${selectedEmployeeLogs.length ? item.requests / selectedEmployeeLogs.length * 100 : 0}%` }} /></div><span>{selectedEmployeeLogs.length ? (item.requests / selectedEmployeeLogs.length * 100).toFixed(1) : 0}%</span></div></td></tr>)}</tbody></table></div>{!selectedEmployeeModels.length && <Empty title="Модели ещё не использованы" text="У сотрудника нет запросов за выбранный период." />}</section>
          <section className="panel employee-requests-panel"><div className="panel-heading"><div><h2>Запросы {selectedEmployee.name}</h2><p>Точное время, модель, токены, стоимость и длительность ответа</p></div><span className="unit-badge">UTC</span></div><div className="table-scroll"><table className="worker-logs-table"><thead><tr><th>Время</th><th>Модель</th><th>Входные токены</th><th>Выходные токены</th><th>Всего токенов</th><th>Стоимость</th><th>Время ответа</th><th>Статус</th></tr></thead><tbody>{selectedEmployeeLogs.slice(0, 100).map(log => <tr key={log.id}><td className="tabular">{dateTimeLabel(log.created_at)}</td><td><span className="model-cell"><Provider name={log.provider} />{modelLabel(log.model)}</span></td><td className="tabular">{number(log.input_tokens)}</td><td className="tabular">{number(log.output_tokens)}</td><td className="tabular"><strong>{number(log.input_tokens + log.output_tokens)}</strong></td><td className="tabular"><strong>{log.status === 'pending' ? '—' : money(log.cost_usd, 5)}</strong></td><td className="tabular">{durationLabel(log.latency_ms)}</td><td><span className={`status ${log.status}`}><i />{log.status === 'success' ? 'Успешно' : log.status === 'pending' ? 'Ожидает расчёта' : 'Ошибка'}</span></td></tr>)}</tbody></table></div>{!selectedEmployeeLogs.length && <Empty title="Запросов пока нет" text="Выберите другой период или сотрудника." />}<div className="table-bottom"><span>{number(selectedEmployeeLogs.length)} запросов · {number(selectedEmployeeTokens)} токенов{selectedEmployeeLogs.length > 100 ? ' · показаны последние 100' : ''}</span><span>Последнее использование: {selectedEmployee.last_active ? dateTimeLabel(selectedEmployee.last_active) : 'нет'}</span></div></section>
        </> : <Empty title="Сотрудников пока нет" text="Добавьте сотрудника, чтобы увидеть его использование ИИ." />)}
        {data && page === 'activity' && <section className="panel"><div className="table-toolbar"><label className="search-field"><Search size={17} /><input placeholder="Сотрудник, модель или ID…" value={query} onChange={e => setQuery(e.target.value)} /></label><div className="toolbar-filters"><label className="select-button"><select aria-label="Провайдер" value={logProvider} onChange={e => setLogProvider(e.target.value)}><option value="all">Все провайдеры</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select><ChevronDown size={14} /></label><label className="select-button"><select aria-label="Статус запроса" value={logStatus} onChange={e => setLogStatus(e.target.value)}><option value="all">Все статусы</option><option value="success">Успешные</option><option value="error">Ошибки</option><option value="pending">Ожидают расчёта</option></select><ChevronDown size={14} /></label></div></div><div className="table-scroll"><table className="logs-table"><thead><tr><th>Сотрудник / время UTC</th><th>Модель</th><th>Токены (вход / выход)</th><th>Стоимость</th><th>Статус</th></tr></thead><tbody>{filteredLogs.slice(logPage * 15, logPage * 15 + 15).map(l => <tr key={l.id}><td><strong>{users.find(u => u.id === l.user_id)?.name || 'Сотрудник'}</strong><small>{dateLabel(l.created_at, true)}</small></td><td><span className="model-cell"><Provider name={l.provider} />{modelLabel(l.model)}</span></td><td className="tabular">{number(l.input_tokens)} <span className="muted">/ {number(l.output_tokens)}</span></td><td className="tabular"><strong>{l.status === 'pending' ? '—' : money(l.cost_usd, 5)}</strong></td><td><span className={`status ${l.status}`}><i />{l.status === 'success' ? 'Успешно' : l.status === 'pending' ? 'Ожидает расчёта' : 'Ошибка'}</span></td></tr>)}</tbody></table></div>{!filteredLogs.length && <Empty title="Запросы не найдены" text="Измените фильтры или отправьте первый запрос через прокси." />}<div className="table-bottom"><span>{number(filteredLogs.length)} запросов · {money(filteredLogs.reduce((s, l) => s + l.cost_usd, 0), 4)}</span><div className="pagination"><button className="icon-button" aria-label="Предыдущая страница" disabled={logPage === 0} onClick={() => setLogPage(p => p - 1)}><ChevronLeft size={17} /></button><span>{logPage + 1} / {Math.max(1, Math.ceil(filteredLogs.length / 15))}</span><button className="icon-button" aria-label="Следующая страница" disabled={(logPage + 1) * 15 >= filteredLogs.length} onClick={() => setLogPage(p => p + 1)}><ChevronRight size={17} /></button></div></div></section>}
        {data && page === 'settings' && <div className="settings-grid"><section className="panel"><div className="panel-heading"><div><h2>Подключённые провайдеры</h2><p>Секретные ключи настраиваются на backend</p></div><ShieldCheck size={20} className="muted" /></div>{(['openai', 'anthropic'] as const).map(p => <div className="provider-setting" key={p}><Provider name={p} label /><span className={`status ${data.providers[p] ? 'active' : 'quarantined'}`}><i />{demo ? 'Демо' : data.providers[p] ? 'Ключ настроен' : 'Не настроен'}</span></div>)}<div className="settings-note">Дашборд не получает и не отображает Master-Key. Для подключения используйте переменные окружения сервера.</div></section><section className="panel"><div className="panel-heading"><div><h2>Защита данных</h2><p>Встроена в архитектуру</p></div><LockKeyhole size={19} className="muted" /></div><div className="security-list"><p><Check size={16} />Хеширование виртуальных ключей SHA-256</p><p><Check size={16} />Проверка VPN IP при каждом запросе</p><p><Check size={16} />Доступ администратора через Supabase Auth</p><p><Check size={16} />Без хранения промптов и ответов</p><p><Check size={16} />Блокировка ключей без кеша доступа</p></div></section><section className="panel full-width"><div className="panel-heading"><div><h2>Тарифы моделей</h2><p>USD за 1 миллион токенов · {demo ? 'иллюстративные тарифы деморежима' : 'тарифы из серверной конфигурации'}</p></div><span className="unit-badge">USD / 1M</span></div><div className="table-scroll"><table><thead><tr><th>Модель</th><th>Входные токены</th><th>Кешированный вход</th><th>Выходные токены</th></tr></thead><tbody>{data.prices.map(p => <tr key={p.model}><td><span className="model-cell"><Provider name={p.provider} />{p.model}</span></td><td>{money(p.input)}</td><td>{money(p.cached_input)}</td><td>{money(p.output)}</td></tr>)}</tbody></table></div><div className="settings-note">Тарифы не обновляются автоматически. Перед рабочим запуском сверьте их с провайдером и укажите в backend/pricing.json. Неизвестные модели отклоняются до обращения к API.</div></section></div>}
        {data && page === 'guide' && <div className="guide-layout"><section className="panel guide-panel"><div className="guide-intro"><span className="guide-icon"><Zap size={24} /></span><h2>Один шлюз для всей команды</h2><p>Сотрудники используют внутренний ключ и адрес вашего прокси. Расходы автоматически появляются в дашборде.</p></div><div className="steps"><article><span>1</span><div><h3>Подключите Supabase и провайдеров</h3><p>Выполните supabase/schema.sql в SQL Editor. Заполните backend/.env и .env по примерам в проекте. Назначьте администратору app_metadata.role = admin.</p></div></article><article><span>2</span><div><h3>Создайте виртуальный ключ</h3><p>Добавьте сотрудника, укажите назначенный VPN IP с маской, месячный бюджет и скопируйте ключ. Он будет показан только один раз.</p><button className="text-button" onClick={() => { setModal('create'); setCreatedKey(''); setFormError('') }}>Добавить сотрудника <ArrowRight size={14} /></button></div></article><article><span>3</span><div><h3>Измените адрес API в приложении</h3><p>Для OpenAI используйте /v1/chat/completions, для Anthropic — /v1/messages. MVP поддерживает только текст и stream: false.</p><div className="code-block"><div><span>Python · OpenAI SDK</span><button aria-label="Скопировать пример" onClick={() => void copy('from openai import OpenAI\n\nclient = OpenAI(\n    base_url="http://localhost:8000/v1",\n    api_key="act_YOUR_VIRTUAL_KEY",\n)\nresponse = client.chat.completions.create(\n    model="YOUR_CONFIGURED_MODEL",\n    messages=[{"role": "user", "content": "Привет!"}],\n    max_completion_tokens=256,\n)')}><Copy size={14} /></button></div><pre><code><span className="code-purple">from</span> openai <span className="code-purple">import</span> OpenAI{'\n\n'}client = OpenAI({'\n'}{'    '}base_url=<span className="code-green">"http://localhost:8000/v1"</span>,{'\n'}{'    '}api_key=<span className="code-green">"act_YOUR_VIRTUAL_KEY"</span>,{'\n'}){'\n'}response = client.chat.completions.create({'\n'}{'    '}model=<span className="code-green">"YOUR_CONFIGURED_MODEL"</span>,{'\n'}{'    '}messages=[{'{'}"role": "user", "content": "Привет!"{'}'}],{'\n'}{'    '}max_completion_tokens=256,{'\n'})</code></pre></div></div></article></div></section><aside className="guide-aside"><div className="panel"><ShieldCheck size={27} className="purple-text" /><h3>Что сохраняется?</h3><p>Сотрудник, настроенный VPN IP, время, модель, количество токенов и стоимость запроса.</p><h3>Что остаётся приватным?</h3><p>Тексты запросов и ответов проходят через прокси в памяти и не сохраняются в базе.</p><p className="muted">Политика хранения самого провайдера регулируется вашим договором с ним.</p></div><a className="docs-link" href={`${apiBase || 'http://localhost:8000'}/docs`} target="_blank" rel="noreferrer">Документация вашего API <ExternalLink size={15} /></a></aside></div>}
      </main>
    </div>
    {modal === 'create' && <Modal title={createdKey ? 'Сотрудник добавлен' : 'Новый сотрудник'} close={() => { setModal(null); setCreatedKey('') }}>{createdKey ? <div className="key-result"><span className="success-circle"><Check size={26} /></span><h3>Виртуальный ключ готов</h3><p>Скопируйте и передайте его сотруднику безопасным способом. Повторно посмотреть ключ нельзя.</p>{demo && <div className="demo-tag">ТЕСТОВЫЙ КЛЮЧ — НЕ РАБОТАЕТ С API</div>}<div className="key-box"><code>{createdKey}</code><button className="icon-button" aria-label="Скопировать ключ" onClick={() => void copy(createdKey)}><Copy size={18} /></button></div><button className="button primary" onClick={() => { setModal(null); setCreatedKey('') }}>Готово</button></div> : <form onSubmit={addUser}><p className="form-description">Создайте личный доступ к ИИ с контролем расходов и проверкой VPN.</p><label>Имя и фамилия<input name="name" placeholder="Анна Смирнова" required minLength={2} maxLength={100} /></label><label>Рабочий email<input name="email" placeholder="anna@company.com" type="email" required maxLength={254} /></label><div className="form-row"><label>Отдел<input name="department" placeholder="Разработка" required maxLength={80} /></label><label>Лимит в месяц, USD<input name="limit" type="number" min="0" max="1000000" step="0.01" defaultValue="100" required /></label></div>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="modal-actions"><button className="button" type="button" onClick={() => setModal(null)}>Отмена</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}Создать ключ</button></div></form>}</Modal>}
    {modal === 'vpnRange' && <Modal title="Диапазон VPN компании" close={() => setModal(null)}><form onSubmit={saveVpnRange}><p className="form-description">Укажите сеть, которую ваш VPN выдаёт сотрудникам. Сервис ничего не выдаёт сам: он лишь проверяет, что VPN IP сотрудника входит в этот диапазон.</p><label>Диапазон VPN компании<input name="vpn_cidr" defaultValue={data?.settings.vpn_cidr || ''} placeholder="10.10.9.0/24" required maxLength={49} autoCapitalize="off" spellCheck={false} /><small>Формат: сеть/маска, например 10.10.9.0/24.</small></label>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="modal-actions"><button className="button" type="button" onClick={() => setModal(null)}>Отмена</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Сохранить диапазон</button></div></form></Modal>}
    {editUser && <Modal title="Настройки сотрудника" close={() => setEditUser(null)}><div className="edit-identity"><span className="avatar tone-0">{initials(editUser.name)}</span><div><strong>{editUser.name}</strong><small>{editUser.email}</small></div></div><form onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); void changeUser(editUser, { vpn_cidr: String(form.get('vpn_cidr')).trim(), monthly_limit: Number(form.get('limit')) }) }}><label>VPN IP с маской<input name="vpn_cidr" defaultValue={editUser.vpn_cidr || ''} placeholder="10.10.9.7/24" required maxLength={49} autoCapitalize="off" spellCheck={false} /><small>Новые запросы будут разрешены только с этого точного IP. Маска сохраняется как часть конфигурации VPN.</small></label><label>Месячный лимит, USD<input name="limit" type="number" defaultValue={editUser.monthly_limit} min="0" max="1000000" step="0.01" required /></label><p className="form-description">Потрачено в этом месяце: {money(editUser.monthly_spend)}. Резерв: {money(editUser.reserved)}. Нулевой лимит блокирует платные запросы.</p>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="modal-actions"><button className={`button ${editUser.status === 'active' ? 'danger' : ''}`} type="button" disabled={busy} onClick={() => void changeUser(editUser, { status: editUser.status === 'active' ? 'quarantined' : 'active' })}>{editUser.status === 'active' ? <ShieldOff size={16} /> : <ShieldCheck size={16} />}{editUser.status === 'active' ? 'Отключить ключ' : 'Восстановить доступ'}</button><button className="button primary" disabled={busy}>Сохранить настройки</button></div></form></Modal>}
    {modal === 'notifications' && <Modal title="Центр внимания" close={() => setModal(null)}><div className="notification-list">{inactive.length > 0 && <article><Users size={20} /><div><h3>Неиспользуемый доступ</h3><p>{inactive.map(u => u.name).join(', ')} — нет запросов за {days} дней. Пересмотрите доступ и лимиты.</p></div></article>}{users.filter(u => u.monthly_limit > 0 && u.monthly_spend / u.monthly_limit >= .8).map(u => <article key={u.id}><Wallet size={20} /><div><h3>{u.name}: бюджет заканчивается</h3><p>Использовано {money(u.monthly_spend)} из {money(u.monthly_limit)}.</p></div></article>)}{reserved > 0 && <article><Activity size={20} /><div><h3>Незавершённые расчёты</h3><p>В резерве {money(reserved)}. Если сумма не меняется, проверьте pending-запросы в истории и сверку с провайдером.</p></div></article>}{!attention && <Empty title="Всё спокойно" text="Сейчас нет предупреждений по расходам и доступу." />}<button className="button primary" onClick={() => { setModal(null); go('employees') }}>Управление сотрудниками <ArrowRight size={16} /></button></div></Modal>}
    {toast && <div className="toast" role="status"><Check size={17} />{toast}<button aria-label="Закрыть уведомление" onClick={() => setToast('')}><X size={15} /></button></div>}
  </div>
}

function Stat({ title, value, icon, children }: { title: string; value: ReactNode; icon: ReactNode; children: ReactNode }) {
  return <article className="stat-card"><div className="stat-top"><span>{title}</span><span className="stat-icon">{icon}</span></div><div className="stat-value">{value}</div><div className="stat-caption">{children}</div></article>
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty-state"><Search size={27} /><h3>{title}</h3><p>{text}</p></div> }
function EmployeeTable({ users, logs, compact: isCompact = false, onEdit, onOpenUsage, onToggle, busy = false }: { users: Employee[]; logs: Log[]; compact?: boolean; onEdit: (u: Employee) => void; onOpenUsage?: (u: Employee) => void; onToggle?: (u: Employee) => void; busy?: boolean }) {
  return <><div className="table-scroll"><table className={`employee-table ${isCompact ? 'key-usage-table' : ''}`}><thead><tr><th>Сотрудник</th><th>Виртуальный ключ / создан</th>{!isCompact && <th>VPN IP / маска</th>}<th>Последнее использование, UTC</th><th>Использование за период</th>{!isCompact && <><th>Расход / мес.</th><th>Лимит / мес.</th><th>Статус</th><th><span className="sr-only">Действия</span></th></>}</tr></thead><tbody>{users.map((u, i) => {
    const userLogs = logs.filter(l => l.user_id === u.id)
    const userTokens = userLogs.reduce((sum, log) => sum + log.input_tokens + log.output_tokens, 0)
    return <tr key={u.id}><td><div className="employee-identity"><span className={`avatar tone-${i % 5}`}>{initials(u.name)}</span><span>{onOpenUsage ? <button className="employee-name-button" onClick={() => onOpenUsage(u)}>{u.name}</button> : <strong>{u.name}</strong>}<small>{isCompact ? u.department : u.email}</small></span></div></td><td><div className="key-audit"><code className="key-prefix">{u.key_prefix}••••</code><small>Создан {dateTimeLabel(u.created_at)}</small></div></td>{!isCompact && <td><code className={`vpn-address ${u.vpn_cidr ? '' : 'missing'}`}>{u.vpn_cidr || 'Не настроен'}</code></td>}<td><span className={u.last_active ? 'last-use' : 'muted'}>{u.last_active ? dateTimeLabel(u.last_active) : 'Ещё не использован'}</span></td><td><div className="usage-count"><strong className="tabular">{number(userLogs.length)} {userLogs.length === 1 ? 'запрос' : 'запросов'}</strong><small>{number(userTokens)} токенов</small></div></td>{!isCompact && <><td><strong className="tabular">{money(u.monthly_spend)}</strong></td><td><div className="limit-cell"><span>{money(u.monthly_limit, 0)}</span><div><i style={{ width: `${u.monthly_limit ? Math.min(100, u.monthly_spend / u.monthly_limit * 100) : 0}%` }} /></div></div></td><td>{onToggle ? <button className={`status ${u.status}`} disabled={busy} onClick={() => onToggle(u)} title={u.status === 'active' ? 'Отключить ключ' : 'Восстановить доступ'}><i />{u.status === 'active' ? 'Активен' : 'Карантин'}</button> : <span className={`status ${u.status}`}><i />{u.status === 'active' ? 'Активен' : 'Карантин'}</span>}</td><td><button className="icon-button" aria-label={`Настройки: ${u.name}`} onClick={() => onEdit(u)}><MoreHorizontal size={19} /></button></td></>}</tr>
  })}</tbody></table></div>{!users.length && <Empty title="Сотрудников пока нет" text="Добавьте сотрудника или измените условия поиска." />}</>
}
