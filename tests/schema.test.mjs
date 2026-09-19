import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

let db
const key = 'a'.repeat(64)
let userId
const reserve = (id, amount, hash = key, sourceIp = '10.10.9.7') => db.query('select public.reserve_request($1,$2,$3,$4,$5,$6,$7)', [hash, id, 'openai', 'test-model', amount, JSON.stringify({ input: '2', cached_input: '.5', output: '8' }), sourceIp])
const settle = (id, amount) => db.query("select public.settle_request($1,'success',100,20,$2,100,null)", [id, amount])

before(async () => {
  db = new PGlite()
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;')
  await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'))
  await db.exec('set role service_role')
  const result = await db.query("insert into public.users(name,email,department,key_hash,key_prefix,vpn_cidr,monthly_limit) values('Test User','test@example.com','Engineering',$1,'act_test','10.10.9.7/24',10) returning id", [key])
  userId = result.rows[0].id
})
after(async () => { await db?.close() })

test('reserves budget, rejects overspend, settles exactly once', async () => {
  const id = randomUUID()
  await reserve(id, '8')
  await assert.rejects(reserve(randomUUID(), '3'), /budget_exceeded/)
  const pending = (await db.query('select * from public.user_finances')).rows[0]
  assert.equal(Number(pending.reserved), 8)
  assert.equal(Number(pending.monthly_spend), 0)
  assert.equal('key_hash' in pending, false)
  await settle(id, '1.25')
  await settle(id, '9')
  const settled = (await db.query('select * from public.user_finances')).rows[0]
  assert.equal(Number(settled.monthly_spend), 1.25)
  assert.equal(Number(settled.reserved), 0)
})

test('quarantine and zero budget block requests', async () => {
  await db.query("update public.users set status='quarantined' where id=$1", [userId])
  await assert.rejects(reserve(randomUUID(), '.01'), /quarantined/)
  await db.query("update public.users set status='active',monthly_limit=0 where id=$1", [userId])
  await assert.rejects(reserve(randomUUID(), '0'), /budget_exceeded/)
  await db.query('update public.users set monthly_limit=10 where id=$1', [userId])
  await assert.rejects(reserve(randomUUID(), '.01', 'b'.repeat(64)), /invalid_key/)
})

test('VPN identity allows the assigned host IP and rejects other addresses', async () => {
  await assert.rejects(reserve(randomUUID(), '.01', key, '10.10.10.7'), /ip_not_allowed/)
  await assert.rejects(reserve(randomUUID(), '.01', key, '10.10.9.8'), /ip_not_allowed/)
  await reserve(randomUUID(), '0', key, '10.10.9.7')
})

test('old spend resets monthly but unresolved reservations remain', async () => {
  await db.query("insert into public.api_logs(id,user_id,provider,model,cost_usd,reserved_usd,status,rates,created_at) values($1,$2,'openai','old',100,0,'success','{}',now()-interval '2 months'),($3,$2,'openai','pending-old',0,2,'pending','{}',now()-interval '2 months')", [randomUUID(), userId, randomUUID()])
  const row = (await db.query('select * from public.user_finances')).rows[0]
  assert.equal(Number(row.monthly_spend), 1.25)
  assert.equal(Number(row.reserved), 2)
  await assert.rejects(reserve(randomUUID(), '7'), /budget_exceeded/)
})

test('anon and authenticated cannot read data or invoke billing', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role}`)
    for (const table of ['users', 'api_logs', 'user_finances']) {
      await assert.rejects(db.query(`select * from public.${table}`), /permission denied/)
    }
    await assert.rejects(reserve(randomUUID(), '0'), /permission denied/)
    await assert.rejects(settle(randomUUID(), '0'), /permission denied/)
  }
  await db.exec('reset role; set role service_role')
})
