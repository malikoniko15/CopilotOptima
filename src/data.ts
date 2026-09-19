export type Employee = {
  id: string; name: string; email: string; department: string;
  status: 'active' | 'quarantined'; key_prefix: string;
  monthly_limit: number; monthly_spend: number; reserved: number;
  last_active: string | null; created_at: string; vpn_cidr?: string | null;
}
export type Log = {
  id: string; user_id: string; provider: string; model: string;
  input_tokens: number; output_tokens: number; cost_usd: number;
  status: 'success' | 'error' | 'pending'; created_at: string; latency_ms: number;
}
export type Price = { provider: string; model: string; input: number; cached_input: number; output: number }
export type Dashboard = {
  users: Employee[]; logs: Log[]; prices: Price[];
  providers: { openai: boolean; anthropic: boolean }; truncated: boolean;
  settings: { vpn_cidr: string | null };
}

const people = [
  ['Анна Смирнова', 'anna.smirnova', 'Разработка', 500],
  ['Михаил Ким', 'mikhail.kim', 'Разработка', 500],
  ['Екатерина Волкова', 'kate.volkova', 'Маркетинг', 300],
  ['Дмитрий Соколов', 'dmitry.sokolov', 'Продукт', 400],
  ['Алексей Петров', 'alex.petrov', 'Разработка', 500],
  ['Мария Иванова', 'maria.ivanova', 'Дизайн', 250],
  ['Олег Новиков', 'oleg.novikov', 'Продажи', 200],
  ['Дарья Ли', 'daria.lee', 'Маркетинг', 250],
] as const

// Illustrative prices and traffic, never used by the gateway for billing.
export const demoPrices: Price[] = [
  { provider: 'openai', model: 'gpt-4.1', input: 2, cached_input: .5, output: 8 },
  { provider: 'openai', model: 'gpt-4.1-mini', input: .4, cached_input: .1, output: 1.6 },
  { provider: 'anthropic', model: 'claude-sonnet-4-20250514', input: 3, cached_input: .3, output: 15 },
]

export function makeDemo(): Dashboard {
  const now = new Date()
  let seed = 41
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const users: Employee[] = people.map(([name, email, department, monthly_limit], i) => ({
    id: `demo-${i}`, name, email: `${email}@acme.team`, department, monthly_limit,
    status: i === 6 ? 'quarantined' : 'active', key_prefix: `act_demo${i + 1}`, vpn_cidr: `10.10.9.${i + 11}/24`,
    monthly_spend: 0, reserved: 0, last_active: null,
    created_at: new Date(now.getTime() - 90 * 86400000).toISOString(),
  }))
  const logs: Log[] = []
  for (let day = 59; day >= 0; day--) {
    const requests = 28 + Math.floor(random() * 34)
    for (let j = 0; j < requests; j++) {
      const user = users[Math.floor(random() * 6)]
      const price = demoPrices[Math.floor(random() * 3)]
      const input = 2000 + Math.floor(random() * 16000)
      const output = 300 + Math.floor(random() * 4200)
      const date = new Date(now)
      date.setUTCDate(date.getUTCDate() - day)
      date.setUTCHours(Math.floor(random() * 24), Math.floor(random() * 60), 0, 0)
      if (date > now) date.setTime(now.getTime() - j * 73000)
      const failed = random() < .018
      const cost = failed ? 0 : (input * price.input + output * price.output) / 1e6
      logs.push({ id: `log-${day}-${j}`, user_id: user.id, provider: price.provider,
        model: price.model, input_tokens: failed ? 0 : input, output_tokens: failed ? 0 : output,
        cost_usd: cost, status: failed ? 'error' : 'success', created_at: date.toISOString(),
        latency_ms: 260 + Math.floor(random() * 2600) })
      if (date.getUTCMonth() === now.getUTCMonth() && date.getUTCFullYear() === now.getUTCFullYear()) user.monthly_spend += cost
      if (!user.last_active || date.toISOString() > user.last_active) user.last_active = date.toISOString()
    }
  }
  return { users, logs: logs.sort((a, b) => b.created_at.localeCompare(a.created_at)),
    prices: demoPrices, providers: { openai: true, anthropic: true }, settings: { vpn_cidr: '10.10.9.0/24' }, truncated: false }
}
