import { createClient } from '@supabase/supabase-js'
import type { Dashboard, Employee } from './data'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY
export const demo = !url && !key
export const configError = Boolean(url) !== Boolean(key)
export const supabase = url && key ? createClient(url, key) : null
export const apiBase = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { data } = await supabase!.auth.getSession()
  if (!data.session) throw new Error('Войдите в аккаунт администратора.')
  const response = await fetch(`${apiBase}/api${path}`, {
    ...options, headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session.access_token}`, ...options.headers },
    signal: AbortSignal.timeout(20000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Не удалось выполнить запрос. Проверьте подключение к серверу.')
  return body as T
}
export const getDashboard = () => request<Dashboard>('/dashboard')
export const createEmployee = (body: { name: string; email: string; department: string; monthly_limit: number }) =>
  request<{ user: Employee; key: string }>('/users', { method: 'POST', body: JSON.stringify(body) })
export const updateEmployee = (id: string, body: { status?: string; vpn_cidr?: string; monthly_limit?: number }) =>
  request<Employee>(`/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
export const updateVpnSettings = (vpn_cidr: string) =>
  request<{ vpn_cidr: string | null }>('/settings/vpn', { method: 'PATCH', body: JSON.stringify({ vpn_cidr }) })
