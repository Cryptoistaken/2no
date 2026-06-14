process.noDeprecation = true

import { Telegraf, Markup } from 'telegraf'
import { spawn } from 'child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'
import { Redis } from 'ioredis'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = path.join(__dirname, '.env')


function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.trim().match(/^([^=]+)=(.*)$/)
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnv()

const TG_TOKEN = process.env.TG_TOKEN
const MULTIBOT_KEY = process.env.MULTIBOT_KEY
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD
const AUTH_USERS = (process.env.AUTHORIZED_USERS || '').split(',').map(Number).filter(Boolean)
const AUTHORIZED_USERS = new Set(AUTH_USERS)
const MAX_NUMBERS_PER_ACCOUNT = 3
const REDIS_URL = process.env.REDIS_URL

if (!TG_TOKEN) { console.error('TG_TOKEN missing in .env'); process.exit(1) }
if (!MULTIBOT_KEY) { console.error('MULTIBOT_KEY missing in .env'); process.exit(1) }
if (!DEFAULT_PASSWORD) { console.error('DEFAULT_PASSWORD missing in .env'); process.exit(1) }
if (AUTHORIZED_USERS.size === 0) { console.error('AUTHORIZED_USERS missing in .env'); process.exit(1) }
if (!REDIS_URL) { console.error('REDIS_URL missing in .env'); process.exit(1) }

const API = 'https://2no.pl'
const KILOMAIL_API = 'https://kilomail.vercel.app/api'
const TURNSTILE_SITEKEY = '0x4AAAAAAAh6YYTPTzEcN3Ep'
const CF_WORKERS = 4

const PYTHON_WORKER = `import sys, json, tls_client

session = tls_client.Session(
    client_identifier="chrome_120",
    random_tls_extension_order=True
)

base_headers = {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "sec-ch-ua": '"Not)A;Brand";v="8", "Chromium";v="138"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-gpc": "1",
    "referer": "https://2nd-no.com/",
    "origin": "https://2nd-no.com/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

for line in sys.stdin:
    req = None
    try:
        req = json.loads(line.strip())
        headers = {**base_headers, **req.get("headers", {})}
        body = req.get("body", {})

        proxy = req.get("proxy")
        if proxy:
            session.proxies = {"http": proxy, "https": proxy}
        else:
            session.proxies = {}

        method = req.get("method", "POST").upper()
        url = req.get("url", "https://2no.pl/")

        if method == "GET":
            resp = session.get(url, headers=headers, timeout_seconds=req.get("timeout", 30))
        elif method == "POST":
            resp = session.post(url, json=body, headers=headers, timeout_seconds=req.get("timeout", 30))
        else:
            raise ValueError(f"Unsupported method: {method}")

        print(json.dumps({
            "id": req.get("id"),
            "status": resp.status_code,
            "headers": dict(resp.headers),
            "body": resp.text
        }, ensure_ascii=False), flush=True)
    except Exception as e:
        rid = req.get("id") if req else None
        print(json.dumps({"id": rid, "error": str(e)}, ensure_ascii=False), flush=True)
`

for (const d of fs.readdirSync(__dirname).filter(f => f.startsWith('2no-py-'))) {
  fs.rmSync(path.join(__dirname, d), { recursive: true, force: true })
}
const WORKER_SCRIPT = path.join(fs.mkdtempSync('2no-py-'), 'worker.py')
fs.writeFileSync(WORKER_SCRIPT, PYTHON_WORKER)

const REDIS_KEY = '2no:data'
const SEEN_KEY = '2no:seen'
const SEEN_CLEANUP_INTERVAL = 3 * 24 * 60 * 60 * 1000
let redis = null
let data = { proxy: null, users: {} }

const _ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false })

const log = {
  info: (msg, tag) => console.log(tag != null ? `${chalk.gray(`${_ts()}`)} ${chalk.cyan(String(tag))} ${chalk.white(msg)}` : `${chalk.gray(`${_ts()}`)} ${chalk.white(msg)}`),
  success: (msg, tag) => console.log(tag != null ? `${chalk.gray(`${_ts()}`)} ${chalk.cyan(String(tag))} ${chalk.white(msg)}` : `${chalk.gray(`${_ts()}`)} ${chalk.white(msg)}`),
  error: (msg, tag) => console.log(tag != null ? `${chalk.gray(`${_ts()}`)} ${chalk.cyan(String(tag))} ${chalk.white(msg)}` : `${chalk.gray(`${_ts()}`)} ${chalk.white(msg)}`),
  warning: (msg, tag) => console.log(tag != null ? `${chalk.gray(`${_ts()}`)} ${chalk.cyan(String(tag))} ${chalk.white(msg)}` : `${chalk.gray(`${_ts()}`)} ${chalk.white(msg)}`),
}
async function loadData() {
  if (!REDIS_URL) return
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, retryStrategy: t => Math.min(t * 100, 2000) })
  redis.on('error', e => console.error(`redis: ${e.message}`))
  try {
    const raw = await redis.get(REDIS_KEY)
    if (raw) {
      data = JSON.parse(raw)
      console.log('data loaded from redis')
    }
  } catch (e) {
    console.warn(`redis load failed: ${e.message}`)
  }
}
await loadData()

async function loadSeenMessages() {
  if (!redis) return
  try {
    const raw = await redis.get(SEEN_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      const cutoff = Date.now() - SEEN_CLEANUP_INTERVAL
      for (const [chatId, msgs] of Object.entries(parsed)) {
        seenMessages[chatId] = new Set()
        for (const [key, ts] of Object.entries(msgs)) {
          if (ts > cutoff) seenMessages[chatId].add(key)
        }
      }
      log.info('seen messages loaded from redis')
    }
  } catch (e) {
    log.warning(`seen messages load failed: ${e.message}`)
  }
}

async function saveSeenMessages() {
  if (!redis) return
  try {
    const obj = {}
    const cutoff = Date.now() - SEEN_CLEANUP_INTERVAL
    for (const [chatId, msgs] of Object.entries(seenMessages)) {
      obj[chatId] = {}
      for (const key of msgs) {
        obj[chatId][key] = Date.now()
      }
    }
    await redis.set(SEEN_KEY, JSON.stringify(obj))
  } catch {}
}

async function cleanupSeenMessages() {
  if (!redis) return
  try {
    const raw = await redis.get(SEEN_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    const cutoff = Date.now() - SEEN_CLEANUP_INTERVAL
    let cleaned = 0
    for (const chatId of Object.keys(parsed)) {
      for (const [key, ts] of Object.entries(parsed[chatId])) {
        if (ts < cutoff) { delete parsed[chatId][key]; cleaned++ }
      }
      if (Object.keys(parsed[chatId]).length === 0) delete parsed[chatId]
    }
    await redis.set(SEEN_KEY, JSON.stringify(parsed))
    if (cleaned > 0) log.info(`cleaned ${cleaned} old seen messages`)
  } catch {}
}

setInterval(cleanupSeenMessages, SEEN_CLEANUP_INTERVAL)
await loadSeenMessages()

if (!data.users) data.users = {}
if (!data.proxy) data.proxy = null
if (!data.stats) data.stats = { captchaSolved: 0, numbersGenerated: 0, messagesReceived: 0 }
if (!data.savedSessions) data.savedSessions = {}
if (!data.oldSessions) data.oldSessions = {}

function saveData() {
  const total = { captchaSolved: 0, numbersGenerated: 0, messagesReceived: 0 }
  for (const u of Object.values(data.users)) {
    total.captchaSolved += u.captchaSolved || 0
    total.numbersGenerated += u.numbersGenerated || 0
    total.messagesReceived += u.messagesReceived || 0
  }
  data.stats = total
  if (redis) redis.set(REDIS_KEY, JSON.stringify(data)).catch(() => {})
}

function getProxy() { return data.proxy }

function parseProxyUrl(str) {
  try {
    const url = new URL(str)
    if (!url.hostname || !url.port) return null
    const proto = url.protocol.replace(':', '')
    const server = `${proto}://${url.hostname}:${url.port}`
    const result = { server }
    if (url.username) result.username = decodeURIComponent(url.username)
    if (url.password) result.password = decodeURIComponent(url.password)
    return result
  } catch {
    return null
  }
}

function printState() {
  const proxy = getProxy()
  const proxyInfo = proxy ? `${proxy.username ? proxy.server.replace('://', `://${proxy.username}:${proxy.password}@`) : proxy.server}` : 'none'
  const s = data.stats || { captchaSolved: 0, numbersGenerated: 0, messagesReceived: 0 }
  const totalEmails = Object.values(data.users).reduce((sum, u) => sum + (u.emails?.length || 0), 0)
  console.log('')
  log.info(`proxy: ${proxyInfo}`)
  log.info(`total: ${s.captchaSolved} captcha, ${s.numbersGenerated} numbers, ${s.messagesReceived} msgs, ${totalEmails} emails`)
  for (const [id, u] of Object.entries(data.users)) {
    let state = 'idle'
    if (processing[id]) state = 'getting numbers'
    else if (pollingSessions[id]) state = 'polling'
    const nums = (u.numbers || []).length
    log.info(`${id} ${state} ${nums} numbers`, 'USER')
  }
  console.log('')
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const sessions = {}
const pollTimers = {}
const pollingSessions = {}
const seenMessages = {}
const processing = {}
const pendingNumber = {}
const monitorMessages = {}
const autoStopTimers = {}
const reAuthLocks = {}
const pendingProxy = {}
const pendingImport = {}

// --- CfClient: Python TLS worker pool ---

class CfClient {
  constructor(workerCount = 4) {
    this.workers = []
    this.pending = new Map()
    this.counter = 0
    this.targetCount = workerCount
    for (let i = 0; i < workerCount; i++) this._spawn()
  }

  _spawn() {
    const proc = spawn('python', [WORKER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    this.workers.push(proc)
    proc.on('error', () => {})
    let buf = ''
    proc.stdout.on('data', c => {
      buf += c.toString()
      const ls = buf.split('\n')
      buf = ls.pop()
      for (const l of ls) {
        if (!l.trim()) continue
        try {
          const r = JSON.parse(l)
          const e = this.pending.get(r.id)
          if (e) { clearTimeout(e._timer); this.pending.delete(r.id); e.resolve(r) }
        } catch (_) {}
      }
    })
    proc.stderr.on('data', d => {
      const msg = d.toString().trim()
      if (msg) log.error(`worker stderr: ${msg}`)
    })
    proc.on('exit', (code) => {
      const i = this.workers.indexOf(proc)
      if (i !== -1) this.workers.splice(i, 1)
      this._spawn()
    })
  }

  _ensureWorker() {
    if (this.workers.length > 0) return
    log.warning('no workers, spawning emergency worker')
    this._spawn()
  }

  _workerIndex(key) {
    this._ensureWorker()
    const len = this.workers.length || 1
    if (!key) return this.counter++ % len
    let h = 5381
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0
    return Math.abs(h) % len
  }

  request(url, body, opts = {}) {
    const id = Date.now() + Math.random()
    const timeoutMs = (opts.timeout || 30) * 1000
    return new Promise((res, rej) => {
      this._ensureWorker()
      const wi = this._workerIndex(opts.sticky)
      const worker = this.workers[wi]
      if (!worker) return rej(new Error('no worker available'))
      const entry = { resolve: res, worker }
      entry._timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          entry.worker.kill()
          rej(new Error('Timeout'))
        }
      }, timeoutMs + 5000)
      this.pending.set(id, entry)
      const msg = JSON.stringify({
        id, url, body, method: opts.method || 'POST',
        proxy: opts.proxy || null,
        headers: opts.headers || {},
        timeout: opts.timeout || 30
      }) + '\n'
      worker.stdin.write(msg)
    })
  }

  close() { for (const w of this.workers) w.kill() }
}

const cfClient = new CfClient(CF_WORKERS)

async function cfRequest(body, sticky) {
  const resp = await cfClient.request(API, body, { sticky })
  if (resp.error) throw new Error(`cfRequest error: ${resp.error}`)
  return JSON.parse(resp.body)
}

async function cfRequestAuth(token, body, sticky) {
  const resp = await cfClient.request(API, body, { headers: { 'x-auth-token': token }, sticky })
  if (resp.error) throw new Error(`cfRequestAuth error: ${resp.error}`)
  return JSON.parse(resp.body)
}

function proxyString() {
  const p = getProxy()
  if (!p) return null
  return p.username ? `${p.server.replace('://', `://${p.username}:${p.password}@`)}` : p.server
}

function cfOpts(extra = {}) {
  const proxy = proxyString()
  return proxy ? { ...extra, proxy } : extra
}

async function cfRequestProxied(body, sticky) {
  const resp = await cfClient.request(API, body, { ...cfOpts(), sticky })
  if (resp.error) throw new Error(`cfRequestProxied error: ${resp.error}`)
  return JSON.parse(resp.body)
}

async function testProxyViaCf(proxyOverride) {
  const proxy = proxyOverride || proxyString()
  if (!proxy) return { ok: false }

  const urls = ['https://api.ipify.org?format=json', 'https://icanhazip.com', 'https://httpbin.org/ip']
  for (const url of urls) {
    try {
      const resp = await cfClient.request(url, {}, { method: 'GET', proxy, timeout: 15 })
      if (resp.error) continue
      const body = resp.body || ''
      const ip = body.match(/(\d+\.\d+\.\d+\.\d+)/)
      if (ip) return { ok: true, ip: ip[1] }
    } catch { continue }
  }
  return { ok: false, error: 'proxy unreachable from container' }
}

function rand(len = 8) {
  return Array.from({ length: len }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
}
function userStats(chatId) {
  if (!data.users[chatId]) {
    data.users[chatId] = { defaultNumbers: 3, captchaSolved: 0, numbersGenerated: 0, messagesReceived: 0, numbers: [], messages: [], emails: [] }
    saveData()
  }
  return data.users[chatId]
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Get Number', 'get_number')],
    [Markup.button.callback('Settings', 'settings')],
  ])
}

function settingsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Set Proxy', 'settings_proxy'), Markup.button.callback('Test Proxy', 'settings_testproxy')],
    [Markup.button.callback('Status', 'settings_status')],
    [Markup.button.callback('Number Count', 'settings_count')],
    [Markup.button.callback('Data', 'settings_data')],
    [Markup.button.callback('Back', 'main')],
  ])
}

function dataMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Export', 'data_export')],
    [Markup.button.callback('Import', 'data_import')],
    [Markup.button.callback('Back', 'settings')],
  ])
}

function countMenu(current) {
  const btn = n => ({ text: n === current ? `* ${n}` : `${n}`, callback_data: `set_count_${n}` })
  return Markup.inlineKeyboard([
    [btn(1), btn(2), btn(3)],
    [Markup.button.callback('Back', 'settings')],
  ])
}

function buildNumList(numbers) {
  return numbers.map((n, i) => `${i + 1}. <code>+48${n.number}</code> 🇵🇱`).join('\n')
}

function stopKeyboard(chatId, msgId) {
  return [[{ text: 'Stop Monitoring', callback_data: `stop_${chatId}_${msgId}` }]]
}

function resumeKeyboard(chatId, msgId) {
  return [[{ text: 'Resume Monitoring', callback_data: `start_monitor_${chatId}_${msgId}` }]]
}

function monitorMessageText(session) {
  return `<b>Your numbers ${session.numbers.length}:</b>\n${buildNumList(session.numbers)}\n\nMonitoring for incoming SMS`
}

async function editMonitorMessage(botOrCtx, chatId, msgId, session) {
  await botOrCtx.telegram.editMessageText(chatId, msgId, undefined, monitorMessageText(session), {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: stopKeyboard(chatId, msgId) }
  }).catch(() => {})
}

async function editStoppedMessage(botOrCtx, chatId, msgId) {
  await botOrCtx.telegram.editMessageText(chatId, msgId, undefined,
    '<b>Monitoring stopped</b>\n\nClick Resume to continue monitoring.',
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: resumeKeyboard(chatId, msgId) } }
  ).catch(() => {})
}

async function solveTurnstile(sitekey, pageurl) {
  const params = new URLSearchParams()
  params.append('key', MULTIBOT_KEY)
  params.append('method', 'turnstile')
  params.append('sitekey', sitekey)
  params.append('pageurl', pageurl)
  params.append('json', '1')
  const resp = await fetch('https://api.multibot.cloud/in.php', { method: 'POST', body: params })
  const text = await resp.text()
  let result
  try { result = JSON.parse(text) } catch { throw new Error(`multibot submit failed: ${text}`) }
  if (result.status !== 1) throw new Error(`multibot returned error: ${text}`)
  const taskId = result.request || result.id
  log.info(`captcha submitted, task ${taskId}`, 'CAPTCHA')
  for (let i = 0; i < 60; i++) {
    await sleep(3000)
    const cr = await fetch(`https://api.multibot.cloud/res.php?key=${MULTIBOT_KEY}&id=${taskId}&json=1`)
    const ct = await cr.text()
    let c
    try { c = JSON.parse(ct) } catch { throw new Error(`multibot poll parse failed: ${ct}`) }
    if (c.status === 1) { log.info(`captcha solved, task ${taskId}`, 'CAPTCHA'); return c.request || c.value }
    if (c.error && c.error !== 'CAPCHA_NOT_READY') throw new Error(`multibot solve error: ${ct}`)
  }
  throw new Error('captcha solving timed out after 3 minutes')
}

function createCaptchaSolver(chatId, maxConcurrent = 2) {
  const queue = []
  let active = 0
  const CAPTCHA_TTL = 250000

  async function _solveOne(entry) {
    active++
    log.info(`captcha solving started, ${queue.length} queued, ${active} active`, chatId)
    try {
      const token = await solveTurnstile(TURNSTILE_SITEKEY, 'https://2nd-no.com/')
      entry.resolve({ token, solvedAt: Date.now() })
      if (chatId) {
        const st = userStats(chatId)
        st.captchaSolved = (st.captchaSolved || 0) + 1
        saveData()
      }
    } catch (e) {
      entry.reject(e)
    } finally {
      active--
      _drain()
    }
  }

  function _drain() {
    while (queue.length > 0 && active < maxConcurrent) {
      _solveOne(queue.shift())
    }
  }

  function _queueCaptcha() {
    return new Promise((resolve, reject) => {
      queue.push({ resolve, reject })
      log.info(`captcha queued, total ${queue.length + active} pending`, chatId)
      _drain()
    })
  }

  return {
    queueCaptcha() {
      return _queueCaptcha().then(r => r.token)
    },
    getValidToken() {
      return _queueCaptcha().then(async ({ token, solvedAt }) => {
        if (Date.now() - solvedAt > CAPTCHA_TTL) return this.getValidToken()
        return token
      })
    },
    preQueue(n) {
      return Array.from({ length: n }, () => _queueCaptcha())
    },
    getPendingCount() { return queue.length },
    getActiveCount() { return active },
  }
}

async function buyNumbers(token, count, solver, captchaPromises, chatId, onProgress, sticky) {
  const bought = []
  for (let i = 0; i < count; i++) {
    log.info(`buying number ${i + 1}/${count}`, chatId)
    if (onProgress) onProgress('progress', `Buying number ${i + 1}/${count}`)

    const avail = await cfRequestAuth(token, { id: 310 }, sticky)
    if (!avail.result || !avail.result.length) {
      log.warning(`no numbers available for purchase ${i + 1}, stopping`, chatId)
      break
    }
    const toBuy = avail.result[0]
    log.info(`available: ${toBuy.number} id ${toBuy.id}`, chatId)

    const { token: captchaToken, solvedAt } = await captchaPromises[i]
    const validToken = Date.now() - solvedAt > 250000 ? await solver.getValidToken() : captchaToken
    log.info('captcha ready, buying', chatId)

    const buyRes = await cfRequestAuth(token, {
      id: 301,
      query: {
        number_id: toBuy.id, name: '', color: '#4893EC',
        availability_days: [1, 2, 3, 4, 5, 6, 7],
        hour_from: '00:00:00.000Z', hour_to: '23:59:59.999Z',
        right_to_transfer_number: true, marketing: false,
        response_key: validToken,
      },
    }, sticky)
    if (!buyRes.success) {
      log.error(`buy ${i + 1} failed: ${JSON.stringify(buyRes)}`, chatId)
      break
    }
    log.success(`number ${i + 1} purchased: ${toBuy.number}`, chatId)
    bought.push({ number: toBuy.number, number_id: toBuy.id })

    if (chatId) {
      const st = userStats(chatId)
      st.numbersGenerated = (st.numbersGenerated || 0) + 1
      if (!st.numbers) st.numbers = []
      st.numbers.push({ number: toBuy.number, number_id: toBuy.id, purchasedAt: new Date().toISOString() })
      saveData()
    }

    if (onProgress) onProgress('number', `+48${toBuy.number}`)
  }
  return bought
}

async function registerOnly(chatId, onProgress) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const email = `${rand(8)}@kilolabs.space`
      const password = DEFAULT_PASSWORD
      if (onProgress) onProgress('progress', `Creating account (${attempt + 1}/3)`)

      const reg = await cfRequestProxied({ id: 103, query: { email, password } }, email)
      if (!reg.success) {
        if (reg.error === 'EmailExists') continue
        throw new Error(`register failed: ${JSON.stringify(reg)}`)
      }
      if (onProgress) onProgress('progress', 'Account created, waiting for verification email')

      let msg = null
      const deadline = Date.now() + 90000
      while (Date.now() < deadline) {
        const inbox = await fetch(`${KILOMAIL_API}/inbox/${encodeURIComponent(email)}`).then(r => r.ok ? r.json() : [])
        if (Array.isArray(inbox) && inbox.length) { msg = inbox[0]; break }
        await sleep(1000)
      }
      if (!msg) { if (onProgress) onProgress('progress', 'Verification email timeout, retrying...'); continue }
      if (onProgress) onProgress('progress', 'Verification email received')

      const body = await fetch(`${KILOMAIL_API}/inbox/${encodeURIComponent(email)}/${msg.id}`).then(r => r.json())
      const html = (body && body.html) || ''
      const text = (body && body.text) || ''
      const m = html.match(/https:\/\/2nd-no\.com\/auth\/create-account\/\?[^\s"<]+/)
      const m2 = text.match(/https:\/\/2nd-no\.com\/auth\/create-account\/\?[^\s"<]+/)
      const verifyLink = m ? m[0].replace(/&amp;/g, '&') : (m2 ? m2[0].replace(/&amp;/g, '&') : null)
      if (!verifyLink) { if (onProgress) onProgress('progress', 'No verify link, retrying...'); continue }

      const urlParams = Object.fromEntries(new URL(verifyLink).searchParams)
      const confirmRes = await cfRequestProxied({ id: 104, query: { email: urlParams.email || email, token: urlParams.token } }, email)
      if (!confirmRes.success) { if (onProgress) onProgress('progress', 'Verification failed, retrying...'); continue }

      if (onProgress) onProgress('progress', 'Account confirmed, logging in')
      const loginRes = await cfRequestProxied({ id: 101, query: { email, password } }, email)
      const token = (loginRes && loginRes.token) || ''
      if (!token) { if (onProgress) onProgress('progress', 'Login failed, retrying...'); continue }

      if (onProgress) onProgress('progress', 'Account ready')
      return { email, password, token }
    } catch (e) {
      log.error(`registration attempt ${attempt + 1} error: ${e.message}`, chatId)
      if (onProgress) onProgress('progress', `Attempt ${attempt + 1} failed: ${e.message.substring(0, 40)}`)
    }
  }
  throw new Error('registration failed after 3 attempts')
}

async function buySingleNumber(session, numberInfo, chatId) {
  const solver = createCaptchaSolver(chatId, 1)
  const captchaToken = await solver.getValidToken()

  log.info(`captcha solved, buying number ${numberInfo.number}`, chatId)

  const buyRes = await cfRequestAuth(session.token, {
    id: 301,
    query: {
      number_id: numberInfo.number_id,
      name: '',
      color: '#4893EC',
      availability_days: [1, 2, 3, 4, 5, 6, 7],
      hour_from: '00:00:00.000Z',
      hour_to: '23:59:59.999Z',
      right_to_transfer_number: true,
      marketing: false,
      response_key: captchaToken,
    },
  }, session.email)

  if (!buyRes.success) {
    throw new Error(`buy failed: ${JSON.stringify(buyRes)}`)
  }

  if (!session.numbers) session.numbers = []
  session.numbers.push({ number: numberInfo.number, number_id: numberInfo.number_id, purchasedAt: new Date().toISOString() })

  const st = userStats(chatId)
  st.numbersGenerated = (st.numbersGenerated || 0) + 1
  if (!st.numbers) st.numbers = []
  st.numbers.push({ number: numberInfo.number, number_id: numberInfo.number_id, purchasedAt: new Date().toISOString() })

  data.savedSessions[chatId] = { email: session.email, password: session.password, numbers: session.numbers, chatId }
  saveData()

  log.success(`number ${numberInfo.number} purchased`, chatId)
  return { number: numberInfo.number, number_id: numberInfo.number_id }
}

async function registerAndGetNumbers(count, chatId, onProgress) {
  for (let attempt = 0; attempt < 3; attempt++) {    try {

    const email = `${rand(8)}@kilolabs.space`
    const password = DEFAULT_PASSWORD
    log.info(`registration attempt ${attempt + 1} with email ${email}`, chatId)
    if (onProgress) onProgress('progress', `Creating account attempt ${attempt + 1} of 3`)

    const solver = createCaptchaSolver(chatId, count)
    const captchaPromises = solver.preQueue(count)

    const reg = await cfRequestProxied({ id: 103, query: { email, password } }, email)
    if (!reg.success) {
      log.error(`registration failed for ${email}: ${JSON.stringify(reg)}`, chatId)
      if (reg.error === 'EmailExists') continue
      throw new Error(`register failed: ${JSON.stringify(reg)}`)
    }
    log.success(`account created: ${email}`, chatId)
    if (onProgress) onProgress('progress', 'Account created, waiting for verification email')

    log.info('waiting for verification email', chatId)
    let msg = null
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const inbox = await fetch(`${KILOMAIL_API}/inbox/${encodeURIComponent(email)}`).then(r => r.ok ? r.json() : [])
      if (Array.isArray(inbox) && inbox.length) { msg = inbox[0]; break }
      await sleep(2000)
    }
    if (!msg) { log.warning('verification email not received', chatId); continue }
    log.success(`verification email arrived: ${msg.subject}`, chatId)
    if (onProgress) onProgress('progress', 'Verification email received, verifying')

    log.info('fetching email body', chatId)
    const body = await fetch(`${KILOMAIL_API}/inbox/${encodeURIComponent(email)}/${msg.id}`).then(r => r.json())
    const html = (body && body.html) || ''
    const text = (body && body.text) || ''
    const m = html.match(/https:\/\/2nd-no\.com\/auth\/create-account\/\?[^\s"<]+/)
    const m2 = text.match(/https:\/\/2nd-no\.com\/auth\/create-account\/\?[^\s"<]+/)
    const verifyLink = m ? m[0].replace(/&amp;/g, '&') : (m2 ? m2[0].replace(/&amp;/g, '&') : null)
    if (!verifyLink) { log.warning('no verify link in email', chatId); continue }
    log.info('calling confirm API', chatId)

    const urlParams = Object.fromEntries(new URL(verifyLink).searchParams)
    const confirmRes = await cfRequestProxied({ id: 104, query: { email: urlParams.email || email, token: urlParams.token } }, email)
    if (!confirmRes.success) {
      log.error(`confirm failed: ${JSON.stringify(confirmRes)}`, chatId)
      continue
    }
    log.success('account confirmed', chatId)
    if (onProgress) onProgress('progress', 'Account confirmed, logging in')

    log.info('getting auth token', chatId)
    if (onProgress) onProgress('progress', 'Getting auth token')
    const loginRes = await cfRequestProxied({ id: 101, query: { email, password } }, email)
    const token = (loginRes && loginRes.token) || ''
    if (!token) { log.error('failed to get auth token after registration', chatId); continue }
    log.success('auth token obtained', chatId)

    const maxBuy = Math.min(count, MAX_NUMBERS_PER_ACCOUNT)
    const bought = await buyNumbers(token, maxBuy, solver, captchaPromises, chatId, onProgress, email)

    if (bought.length === 0) { log.warning('no numbers bought, retrying', chatId); continue }

    log.success(`registration complete, ${bought.length} numbers`, chatId)
    if (chatId) {
      const st = userStats(chatId)
      if (!st.emails) st.emails = []
      st.emails.push({ email, createdAt: new Date().toISOString() })
      saveData()
    }
    return { email, password, token, numbers: bought }
      } catch (e) {
      log.error(`registration attempt ${attempt + 1} error: ${e.message}`, chatId)
    }
}
  throw new Error('registration failed after 3 attempts')
}

async function loginAndGetNumbers(session, count, chatId, onProgress) {
  log.info('logging into existing account', chatId)
  log.info(`email ${session.email}`, chatId)
  if (onProgress) onProgress('progress', 'Logging in')

  const sticky = session.email
  const solver = createCaptchaSolver(chatId, count)

  log.info('performing login', chatId)
  const loginRes = await cfRequestProxied({ id: 101, query: { email: session.email, password: session.password } }, sticky)
  const token = (loginRes && loginRes.token) || ''
  if (!token) { log.error('login failed: no token returned', chatId); throw new Error('login failed: no token returned') }
  log.success('login successful', chatId)
  if (onProgress) onProgress('progress', 'Login successful, checking numbers')

  const myNums = await cfRequestAuth(token, { id: 311 }, sticky)
  const existing = myNums.result || []
  log.info(`existing numbers: ${existing.length}`, chatId)

  const needCount = Math.max(0, Math.min(count, MAX_NUMBERS_PER_ACCOUNT) - existing.length)

  if (needCount === 0) {
    log.info(`already have ${existing.length} numbers, using existing`, chatId)
    if (onProgress) onProgress('progress', 'Using existing numbers')
    const numbers = existing.map(e => ({ number: e.number, number_id: e.number_id }))
    if (onProgress) {
      for (const n of numbers) onProgress('number', `+48 ${n.number}`)
    }
    return { token, numbers }
  }

  log.info(`need to buy ${needCount} more numbers`, chatId)
  if (onProgress) onProgress('progress', `Need to buy ${needCount} more numbers`)
  const captchaPromises = solver.preQueue(needCount)

  const bought = await buyNumbers(token, needCount, solver, captchaPromises, chatId, onProgress, sticky)
  const allNumbers = [...existing.map(e => ({ number: e.number, number_id: e.number_id })), ...bought]

  return { token, numbers: allNumbers }
}

async function stopPolling(chatId) {
  if (pollTimers[chatId]) {
    log.info('stopping SMS poll timer', chatId)
    clearTimeout(pollTimers[chatId])
    delete pollTimers[chatId]
  }
  delete pollingSessions[chatId]
  if (autoStopTimers[chatId]) {
    clearTimeout(autoStopTimers[chatId])
    delete autoStopTimers[chatId]
  }
  printState()
}

async function pollApi(token, body) {
  return cfRequestAuth(token, body)
}

function detectSender(body) {
  const services = [
    [['X', 'Twitter'], /\b(?:x|twitter)\b/i],
    [['Telegram'], /\btelegram\b/i],
    [['ChatGPT'], /\b(?:chatgpt|chat gpt|openai|open ai)\b/i],
    [['Claude', 'Anthropic'], /\b(?:claude|anthropic)\b/i],
    [['IMO'], /\bimo\b/i],
    [['Facebook', 'Meta'], /\b(?:facebook|meta)\b/i],
    [['Instagram'], /\b(?:instagram|insta)\b/i],
    [['WhatsApp'], /\b(?:whatsapp|wa)\b/i],
    [['Snapchat'], /\b(?:snapchat|snap)\b/i],
    [['TikTok'], /\btiktok\b/i],
    [['Discord'], /\bdiscord\b/i],
    [['Signal'], /\bsignal\b/i],
    [['LinkedIn'], /\blinkedin\b/i],
    [['Google'], /\b(?:google|gmail)\b/i],
    [['Microsoft', 'Outlook'], /\b(?:microsoft|outlook)\b/i],
    [['Apple', 'iMessage'], /\b(?:apple|imessage)\b/i],
    [['Amazon'], /\bamazon\b/i],
    [['Netflix'], /\bnetflix\b/i],
    [['Spotify'], /\bspotify\b/i],
    [['Uber'], /\buber\b/i],
    [['PayPal'], /\bpaypal\b/i],
    [['Binance'], /\bbinance\b/i],
    [['Coinbase'], /\bcoinbase\b/i],
    [['Reddit'], /\breddit\b/i],
    [['Twitch'], /\btwitch\b/i],
    [['Yahoo'], /\byahoo\b/i],
    [['Pinterest'], /\bpinterest\b/i],
  ]
  for (const [names, regex] of services) {
    if (regex.test(body)) return names[0]
  }
  return 'unknown'
}

async function startPolling(chatId, session) {
  await stopPolling(chatId)
  if (!seenMessages[chatId]) seenMessages[chatId] = new Set()
  pollingSessions[chatId] = true

  log.info(`started SMS polling for +48 ${session.numbers.map(n => n.number).join(', ')}`, chatId)

  const startTime = Date.now()
  const FAST_INTERVAL = 1000
  const SLOW_INTERVAL = 5000
  const FAST_DURATION = 5 * 60 * 1000
  let pollCount = 0

  async function poll() {
    if (!pollingSessions[chatId]) return
    pollCount++
    try {
      const msgs = await pollApi(session.token, {
        id: 414,
        query: { offset: 0, limit: 50, order_by: [{ field: 'created_at', order: 'DESC' }] },
      })

      if (msgs.error === 1003 && msgs.code === 401) {
        log.warning('token expired, attempting re-login', chatId)
        if (reAuthLocks[chatId]) { return scheduleNext() }
        reAuthLocks[chatId] = true
        try {
          const loginRes = await cfRequestProxied({ id: 101, query: { email: session.email, password: session.password } }, session.email)
          const newToken = (loginRes && loginRes.token) || null
          if (!newToken) throw new Error('re-login failed')
          session.token = newToken
          sessions[chatId] = session
          log.success('token refreshed', chatId)
        } catch (e) {
          log.error(`re-login failed: ${e.message}`, chatId)
        } finally {
          delete reAuthLocks[chatId]
        }
        return scheduleNext()
      }

      const numberIds = (session.numbers || []).map(n => n.number_id)
      const forNumbers = (msgs.result || []).filter(m => numberIds.includes(m.number_id))

      if (!forNumbers.length && pollCount % 6 === 0) {
        const nums = (session.numbers || []).map(n => `+48${n.number}`).join(', ')
        log.info(`poll OK, ${(msgs.result || []).length} total messages. listening [${nums}]`, chatId)
      }

      for (const m of forNumbers) {
        const key = m.id || (m.body ? m.body.slice(0, 100) : '')
        if (seenMessages[chatId] && seenMessages[chatId].has(key)) continue
        seenMessages[chatId].add(key)
        saveSeenMessages()

        const body = m.body || m.text || 'empty'
        const sender = m.from_number || m.from || detectSender(body)
        const time = m.created_at ? new Date(m.created_at).toLocaleString() : ''
        const num = (session.numbers || []).find(n => n.number_id === m.number_id)
        const numTag = num ? `<code>+48${num.number}</code> 🇵🇱` : ''

        log.info(`SMS +48 ${num ? num.number : '?'} from ${sender}: ${body.slice(0, 80)}`, chatId)

        const st = userStats(chatId)
        st.messagesReceived = (st.messagesReceived || 0) + 1
        if (!st.messages) st.messages = []
        st.messages.push({ from: sender, body, time, number: num ? `+48 ${num.number}` : '', receivedAt: new Date().toISOString() })
        saveData()

        if (bot) {
          const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          const bodyEsc = esc(body)
          const codeMatch = body.match(/\b(\d{4,8})\b/)
          const lines = []
          if (numTag) lines.push(numTag)
          lines.push(`<b>From:</b> ${esc(sender)}`)
          if (codeMatch) lines.push(`<b>Code:</b> <code>${codeMatch[1]}</code>`)
          if (time) lines.push(`<b>Time:</b> ${time}`)
          lines.push(`<b>Message:</b> ${bodyEsc}`)
          bot.telegram.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' }).catch((e) => {
            log.error(`telegram send failed: ${e.message}`, chatId)
          })
        }
      }
    } catch (e) {
      log.error(`polling error: ${e.message}`, chatId)
    }
    scheduleNext()
  }

  function scheduleNext() {
    if (!pollingSessions[chatId]) return
    const elapsed = Date.now() - startTime
    const interval = elapsed < FAST_DURATION ? FAST_INTERVAL : SLOW_INTERVAL
    if (elapsed >= FAST_DURATION && elapsed - (interval === SLOW_INTERVAL ? SLOW_INTERVAL : FAST_INTERVAL) < FAST_DURATION) {
      log.info('switched to slow polling (5s)', chatId)
    }
    pollTimers[chatId] = setTimeout(poll, interval)
  }

  scheduleNext()
  autoStopTimers[chatId] = setTimeout(() => {
    log.info('2-hour auto-stop triggered', chatId)
    stopPolling(chatId)
    const msgId = monitorMessages[chatId]
    if (msgId) {
      editStoppedMessage(bot, chatId, msgId)
    }
    printState()
  }, 1800000)
}

function getUserDefaultNumbers(chatId) {
  const u = data.users[chatId]
  return (u && u.defaultNumbers) || MAX_NUMBERS_PER_ACCOUNT
}

function setUserDefaultNumbers(chatId, count) {
  const st = userStats(chatId)
  st.defaultNumbers = count
  saveData()
}

async function processGetNumber(ctx) {
  const chatId = ctx.chat.id
  if (processing[chatId]) {
    await ctx.answerCbQuery('Already processing...')
    return
  }

  processing[chatId] = true
  await ctx.answerCbQuery()

  try {
    let session = sessions[chatId]

    if (!session || (session.numbers && session.numbers.length >= MAX_NUMBERS_PER_ACCOUNT)) {
      const msg = await ctx.reply('Setting up account...')

      if (session) {
        data.oldSessions[chatId] = { ...session }
      }

      const result = await registerOnly(chatId, (type, data) => {
        if (type === 'progress') {
          ctx.telegram.editMessageText(chatId, msg.message_id, undefined, data).catch(() => {})
        }
      })

      session = {
        email: result.email,
        password: DEFAULT_PASSWORD,
        token: result.token,
        numbers: [],
        chatId,
      }
      sessions[chatId] = session
      data.savedSessions[chatId] = { email: session.email, password: session.password, numbers: session.numbers, chatId }
      saveData()

      await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, 'Account ready!').catch(() => {})
    }

    const avail = await cfRequestAuth(session.token, { id: 310 }, session.email)
    if (!avail.result || !avail.result.length) {
      await ctx.reply('No numbers available. Try again later.', { ...mainMenu() })
      return
    }

    const num = avail.result[0]
    pendingNumber[chatId] = { number: num.number, number_id: num.id }

    const bought = session.numbers ? session.numbers.length : 0

    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback('Use This', 'confirm_buy'),
        Markup.button.callback('Refresh', 'refresh_number'),
      ],
      [Markup.button.callback('« Main Menu', 'main')],
    ])

    await ctx.reply(
      `<code>+48${num.number}</code> 🇵🇱\n\n` +
      `Account: ${bought}/${MAX_NUMBERS_PER_ACCOUNT} numbers owned\n` +
      `Refresh - see another number\n` +
      `Use This - purchase this number`,
      { parse_mode: 'HTML', ...kb }
    )

  } catch (e) {
    log.error(`get number error: ${e.message}`, chatId)
    await ctx.reply('Error: ' + e.message.substring(0, 100), { ...mainMenu() })
  } finally {
    delete processing[chatId]
  }
}

async function resumeSessions() {
  const saved = data.savedSessions || {}
  const old = data.oldSessions || {}
  const entries = [...Object.entries(saved), ...Object.entries(old)]
  if (!entries.length) return
  log.info(`resuming ${entries.length} saved session(s)`)
  for (const [chatId, s] of entries) {
    if (sessions[chatId]) continue
    if (s.stopped) {
      log.info(`skipping stopped session ${chatId}`, chatId)
      continue
    }
    if (!s.numbers || !s.numbers.length) {
      log.info(`skipping session ${chatId} with 0 numbers`, chatId)
      delete data.savedSessions[chatId]
      delete data.oldSessions[chatId]
      saveData()
      continue
    }
    ;(async () => {
      let lastError
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) {
          const delay = attempt * 5000
          log.info(`retry ${attempt}/3 for ${chatId} in ${delay}ms`, chatId)
          await new Promise(r => setTimeout(r, delay))
        }
        try {
          log.info(`resuming session ${chatId} (attempt ${attempt}/3), ${s.numbers.length} number(s): ${s.numbers.map(n => n.number).join(', ')}`, chatId)
          const loginRes = await cfRequestProxied({ id: 101, query: { email: s.email, password: s.password } }, s.email)
          const token = (loginRes && loginRes.token) || ''
          if (!token) {
            log.error(`resume login failed for ${chatId}`, chatId)
            delete data.savedSessions[chatId]
            delete data.oldSessions[chatId]
            saveData()
            bot.telegram.sendMessage(chatId, 'Number resume failed. Get new numbers to start.', { ...mainMenu() }).catch(() => {})
            return
          }
          const session = { email: s.email, password: s.password, token, numbers: s.numbers, chatId }
          sessions[chatId] = session
          delete data.oldSessions[chatId]
          saveData()
          await startPolling(chatId, session)
          log.success(`session resumed for ${chatId}`, chatId)
          printState()
          return
        } catch (e) {
          lastError = e.message
          log.error(`resume attempt ${attempt}/3 failed for ${chatId}: ${e.message}`, chatId)
        }
      }
      log.error(`resume failed for ${chatId} after 3 attempts: ${lastError}`, chatId)
      delete data.savedSessions[chatId]
      delete data.oldSessions[chatId]
      saveData()
      bot.telegram.sendMessage(chatId, 'Number resume failed. Get new numbers to start.', { ...mainMenu() }).catch(() => {})
    })()
  }
}

let bot = new Telegraf(TG_TOKEN)

bot.use((ctx, next) => {
  const chatId = ctx.chat?.id
  if (chatId && !AUTHORIZED_USERS.has(chatId)) {
    log.error(`unauthorized access attempt from ${chatId}`, 'AUTH')
    return ctx.reply('You are not authorized to use this bot.')
  }
  return next()
})

bot.start((ctx) => {
  const chatId = ctx.chat.id
  log.info('bot started by user, showing main menu', chatId)
  return ctx.reply('Choose an option:', mainMenu())
})

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id
  if (pendingImport[chatId]) {
    delete pendingImport[chatId]
    if (!ctx.message.document) return ctx.reply('Send a file please')
    try {
      const fileId = ctx.message.document.file_id
      const fileLink = await ctx.telegram.getFileLink(fileId)
      const resp = await fetch(fileLink.href)
      const raw = await resp.text()
      const imported = JSON.parse(raw)
      if (!imported || typeof imported !== 'object') throw new Error('invalid format')
      data = imported
      if (!data.users) data.users = {}
      if (!data.stats) data.stats = { captchaSolved: 0, numbersGenerated: 0, messagesReceived: 0 }
      saveData()
      log.success('data imported successfully', chatId)
      return ctx.reply('Data imported successfully')
    } catch (e) {
      log.error(`import failed: ${e.message}`, chatId)
      return ctx.reply(`Import failed: ${e.message}`)
    }
  }

  if (pendingProxy[chatId]) {
    delete pendingProxy[chatId]
    const input = ctx.message.text.trim()
    const parsed = parseProxyUrl(input)
    if (!parsed) return ctx.reply('Invalid proxy format. Use: http://user:pass@host:port')
    const result = await testProxyViaCf(input)
    if (!result.ok) return ctx.reply(`Proxy test failed: ${result.error}`)
    data.proxy = parsed
    saveData()
    log.success(`proxy updated to ${parsed.server}, ip ${result.ip}`, chatId)
    printState()
    return ctx.reply(`Proxy updated and working, IP: ${result.ip}`)
  }
})

bot.action(/stop_(\d+)_(\d+)/, async (ctx) => {
  const chatId = Number(ctx.match[1])
  const msgId = Number(ctx.match[2])
  if (ctx.chat.id !== chatId) return ctx.answerCbQuery('Not your session')
  await ctx.answerCbQuery()
  const confirm = [[
    { text: 'Yes, stop', callback_data: `stop_confirm_${chatId}_${msgId}` },
    { text: 'No', callback_data: `stop_cancel_${chatId}_${msgId}` },
  ]]
  await ctx.editMessageReplyMarkup({ inline_keyboard: confirm })
})

bot.action(/stop_confirm_(\d+)_(\d+)/, async (ctx) => {
  const chatId = Number(ctx.match[1])
  const msgId = Number(ctx.match[2])
  if (ctx.chat.id !== chatId) return ctx.answerCbQuery('Not your session')
  await ctx.answerCbQuery('Stopped monitoring')
  await stopPolling(chatId)
  if (sessions[chatId]) {
    sessions[chatId].numbers = []
  }
  if (data.savedSessions[chatId]) data.savedSessions[chatId].stopped = true
  if (data.oldSessions[chatId]) data.oldSessions[chatId].stopped = true
  saveData()
  await editStoppedMessage(ctx, chatId, msgId)
  printState()
})

bot.action(/stop_cancel_(\d+)_(\d+)/, async (ctx) => {
  const chatId = Number(ctx.match[1])
  const msgId = Number(ctx.match[2])
  if (ctx.chat.id !== chatId) return ctx.answerCbQuery('Not your session')
  await ctx.answerCbQuery()
  const session = sessions[chatId]
  if (session && session.numbers.length) {
    await editMonitorMessage(ctx, chatId, msgId, session)
  } else {
    await ctx.editMessageReplyMarkup({})
  }
})

bot.action(/start_monitor_(\d+)_(\d+)/, async (ctx) => {
  const chatId = Number(ctx.match[1])
  const msgId = Number(ctx.match[2])
  if (ctx.chat.id !== chatId) return ctx.answerCbQuery('Not your session')
  await ctx.answerCbQuery()
  let session
  if (data.oldSessions[chatId] && data.oldSessions[chatId].numbers && data.oldSessions[chatId].numbers.length) {
    session = { ...data.oldSessions[chatId], chatId: Number(chatId), stopped: false }
    delete data.oldSessions[chatId]
    sessions[chatId] = session
    saveData()
  } else if (data.savedSessions[chatId] && data.savedSessions[chatId].numbers && data.savedSessions[chatId].numbers.length) {
    session = { ...data.savedSessions[chatId], chatId: Number(chatId), stopped: false }
    sessions[chatId] = session
  } else {
    session = sessions[chatId]
    if (!session || !session.numbers.length) {
      await ctx.telegram.editMessageText(chatId, msgId, undefined,
        'No numbers to monitor.'
      ).catch(() => {})
      return ctx.reply('Choose an option:', mainMenu())
    }
  }
  const oldest = session.numbers.reduce((min, n) => Math.min(min, n.created_at || Infinity), Infinity) * 1000
  if (oldest && Date.now() - oldest > 86400000) {
    await ctx.telegram.editMessageText(chatId, msgId, undefined,
      'Numbers expired (24h limit). Create new numbers.'
    ).catch(() => {})
    return ctx.reply('Choose an option:', mainMenu())
  }
  try {
    const loginRes = await cfRequestProxied({ id: 101, query: { email: session.email, password: session.password } }, session.email)
    const token = (loginRes && loginRes.token) || ''
    if (!token) throw new Error('login failed')
    session.token = token
    sessions[chatId] = session
    await startPolling(chatId, session)
    monitorMessages[chatId] = msgId
    await editMonitorMessage(ctx, chatId, msgId, session)
    printState()
  } catch (e) {
    log.error(`start monitor failed: ${e.message}`, chatId)
    await ctx.telegram.editMessageText(chatId, msgId, undefined, `Error: ${e.message}`).catch(() => {})
  }
})

bot.action('settings', async (ctx) => {
  const chatId = ctx.chat.id
  log.info('opened settings', chatId)
  await ctx.answerCbQuery()
  await ctx.editMessageText('Settings:', settingsMenu())
})

bot.action('settings_back', async (ctx) => {
  const chatId = ctx.chat.id
  log.info('back to main menu', chatId)
  await ctx.answerCbQuery()
  await ctx.editMessageText('Choose an option:', mainMenu())
})

bot.action('settings_data', async (ctx) => {
  const chatId = ctx.chat.id
  log.info('opened data menu', chatId)
  await ctx.answerCbQuery()
  await ctx.editMessageText('Data management:', dataMenu())
})

bot.action('data_export', async (ctx) => {
  const chatId = ctx.chat.id
  log.info('exporting data', chatId)
  await ctx.answerCbQuery()
  const buf = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
  await ctx.replyWithDocument({ source: buf, filename: 'data.json' })
})

bot.action('data_import', async (ctx) => {
  const chatId = ctx.chat.id
  log.info('requested data import', chatId)
  await ctx.answerCbQuery()
  pendingImport[chatId] = true
  await ctx.editMessageText('Send me the data.json file to import', dataMenu())
})



bot.action('settings_proxy', async (ctx) => {
  const chatId = ctx.chat.id
  log.info('requested proxy change', chatId)
  await ctx.answerCbQuery()
  const proxy = getProxy()
  const currentInfo = proxy ? `Current: ${proxyString()}` : 'No proxy set'
  pendingProxy[ctx.chat.id] = true
  await ctx.editMessageText(`Send proxy URL in format:\nhttp://user:pass@host:port\n\n${currentInfo}`,
    Markup.inlineKeyboard([[Markup.button.callback('Back', 'settings')]]))
})

bot.action('settings_testproxy', async (ctx) => {
  await ctx.answerCbQuery()
  const chatId = ctx.chat.id
  const proxy = getProxy()
  if (!proxy) return ctx.reply('No proxy set')
  const result = await testProxyViaCf()
  if (result.ok) {
    log.success(`proxy test ok, ip ${result.ip}`, chatId)
    return ctx.reply(`Proxy is working, IP: ${result.ip}`)
  }
  log.error('proxy test failed', chatId)
  return ctx.reply('Proxy test failed, provide a new one')
})

bot.action('settings_status', async (ctx) => {
  const chatId = ctx.chat.id
  log.info('viewed status', chatId)
  await ctx.answerCbQuery()
  const st = userStats(chatId)
  const nums = (st.numbers || []).map(n => `+48 ${n.number}`).join(', ') || 'none'
  const s = data.stats || {}
  const lines = [
    `Captcha solved: ${s.captchaSolved || 0}`,
    `Numbers generated: ${s.numbersGenerated || 0}`,
    `Messages received: ${s.messagesReceived || 0}`,
    `Your numbers: ${nums}`,
  ]
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('Reset Status', 'status_reset')],
    [Markup.button.callback('Back', 'settings')],
  ])
  await ctx.editMessageText(lines.join('\n'), kb)
})

bot.action('status_reset', async (ctx) => {
  const chatId = ctx.chat.id
  await ctx.answerCbQuery()
  const confirm = Markup.inlineKeyboard([
    [Markup.button.callback('Yes, reset', 'status_reset_yes'), Markup.button.callback('No', 'status_reset_no')],
  ])
  await ctx.editMessageText('Reset all stats? This cannot be undone.', confirm)
})

bot.action('status_reset_no', async (ctx) => {
  const chatId = ctx.chat.id
  await ctx.answerCbQuery()
  return ctx.telegram.editMessageText(chatId, ctx.callbackQuery.message.message_id, undefined, 'Cancelled.', settingsMenu()).catch(() => {})
})

bot.action('status_reset_yes', async (ctx) => {
  const chatId = ctx.chat.id
  await ctx.answerCbQuery('Stats reset')
  data.stats = { captchaSolved: 0, numbersGenerated: 0, messagesReceived: 0 }
  for (const u of Object.values(data.users)) {
    u.captchaSolved = 0
    u.numbersGenerated = 0
    u.messagesReceived = 0
    u.numbers = []
    u.messages = []
    u.emails = []
  }
  saveData()
  log.success('stats reset', chatId)
  await ctx.telegram.editMessageText(chatId, ctx.callbackQuery.message.message_id, undefined,
    'Stats reset.', settingsMenu()
  ).catch(() => {})
})

bot.action('settings_count', async (ctx) => {
  const chatId = ctx.chat.id
  log.info('opened count settings', chatId)
  await ctx.answerCbQuery()
  const cur = getUserDefaultNumbers(chatId)
  await ctx.editMessageText(`Current count: ${cur}. Choose new count:`, countMenu(cur))
})

for (let n = 1; n <= 3; n++) {
  bot.action(`set_count_${n}`, async (ctx) => {
    const chatId = ctx.chat.id
    setUserDefaultNumbers(chatId, n)
    log.info(`default count set to ${n}`, chatId)
    await ctx.answerCbQuery(`Default set to ${n}`)
    await ctx.editMessageText(`Current count: ${n}. Choose new count:`, countMenu(n))
  })
}

bot.action('get_number', async (ctx) => {
  await processGetNumber(ctx)
})

bot.action('refresh_number', async (ctx) => {
  const chatId = ctx.chat.id
  const session = sessions[chatId]
  if (!session) {
    await ctx.answerCbQuery('Session expired')
    return ctx.editMessageText('Session expired. Get a new number.', { ...mainMenu() })
  }

  await ctx.answerCbQuery()

  try {
    const avail = await cfRequestAuth(session.token, { id: 310 }, session.email)
    if (!avail.result || !avail.result.length) {
      await ctx.editMessageText('No numbers available.', { ...Markup.inlineKeyboard([[Markup.button.callback('« Main Menu', 'main')]]) })
      return
    }

    const num = avail.result[0]
    pendingNumber[chatId] = { number: num.number, number_id: num.id }

    const bought = session.numbers ? session.numbers.length : 0

    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback('Use This', 'confirm_buy'),
        Markup.button.callback('Refresh', 'refresh_number'),
      ],
      [Markup.button.callback('« Main Menu', 'main')],
    ])

    await ctx.editMessageText(
      `<code>+48${num.number}</code> 🇵🇱\n\n` +
      `Account: ${bought}/${MAX_NUMBERS_PER_ACCOUNT} numbers owned\n` +
      `Refresh - see another number\n` +
      `Use This - purchase this number`,
      { parse_mode: 'HTML', ...kb }
    )
  } catch (e) {
    log.error(`refresh error: ${e.message}`, chatId)
    await ctx.answerCbQuery('Refresh failed, try again')
  }
})

bot.action('confirm_buy', async (ctx) => {
  const chatId = ctx.chat.id
  const session = sessions[chatId]
  const pending = pendingNumber[chatId]

  if (!session || !pending) {
    await ctx.answerCbQuery('Session expired')
    await ctx.editMessageText('Session expired. Use Main Menu to start over.', { ...Markup.inlineKeyboard([[Markup.button.callback('« Main Menu', 'main')]]) })
    return
  }

  if (session.numbers && session.numbers.length >= MAX_NUMBERS_PER_ACCOUNT) {
    await ctx.answerCbQuery('Account limit reached')
    await ctx.editMessageText(`This account has reached the maximum of ${MAX_NUMBERS_PER_ACCOUNT} purchases.\nUse Main Menu to create a new account.`, { ...Markup.inlineKeyboard([[Markup.button.callback('« Main Menu', 'main')]]) })
    return
  }

  await ctx.answerCbQuery()
  await ctx.editMessageText('Solving captcha and purchasing number...')

  try {
    const result = await buySingleNumber(session, pending, chatId)

    delete pendingNumber[chatId]

    const bought = session.numbers ? session.numbers.length : 0
    const remaining = MAX_NUMBERS_PER_ACCOUNT - bought

    if (remaining > 0) {
      await ctx.editMessageText(
        `<b>Number purchased!</b>\n<code>+48${result.number}</code> 🇵🇱\n\n` +
        `Account: ${bought}/${MAX_NUMBERS_PER_ACCOUNT} numbers owned\n` +
        `Get another number from the menu below.`,
        { parse_mode: 'HTML', ...mainMenu() }
      )
    } else {
      await ctx.editMessageText(
        `<b>Number purchased!</b>\n<code>+48${result.number}</code> 🇵🇱\n\n` +
        `Account: ${bought}/${MAX_NUMBERS_PER_ACCOUNT} numbers owned (limit reached)\n` +
        `Use Main Menu to create a new account for more numbers.`,
        { parse_mode: 'HTML', ...mainMenu() }
      )
    }

    await stopPolling(chatId)
    await startPolling(chatId, session)

    const monitorMsg = await ctx.reply(monitorMessageText(session), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: stopKeyboard(chatId, 0) },
    })
    monitorMessages[chatId] = monitorMsg.message_id
    await ctx.telegram.editMessageReplyMarkup(chatId, monitorMsg.message_id, undefined, {
      inline_keyboard: stopKeyboard(chatId, monitorMsg.message_id),
    }).catch(() => {})
  } catch (e) {
    log.error(`buy error: ${e.message}`, chatId)
    await ctx.editMessageText('Purchase failed: ' + e.message.substring(0, 100), { ...Markup.inlineKeyboard([[Markup.button.callback('« Main Menu', 'main')]]) })
  }
})

bot.action('main', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.editMessageText('Choose an option:', mainMenu())
})

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  fs.rmSync(path.dirname(WORKER_SCRIPT), { recursive: true, force: true })
  console.log(`Usage: node test/nobrowser/nobrowser.js [options]

Options:
  --generate N, -g N   Generate N numbers in CLI mode and print result as JSON
  --proxy URL, -p URL   Set proxy for signup/login (e.g. http://user:pass@host:port)
  --help, -h           Show this help

Without arguments, runs the Telegram bot.`)
  process.exit(0)
}

const proxyIdx = args.findIndex(a => a === '--proxy' || a === '-p')
if (proxyIdx !== -1) {
  const parsed = parseProxyUrl(args[proxyIdx + 1])
  if (parsed) data.proxy = parsed
}

const genIdx = args.findIndex(a => a === '--generate' || a === '-g')
if (genIdx !== -1) {
  const count = Math.min(parseInt(args[genIdx + 1], 10) || 1, 3)
  log.info(`CLI generate ${count} number(s)`)
  const cleanup = () => fs.rmSync(path.dirname(WORKER_SCRIPT), { recursive: true, force: true })
  registerAndGetNumbers(count, null, null).then(result => {
    cleanup()
    console.log(JSON.stringify({ email: result.email, password: result.password, token: result.token, numbers: result.numbers }, null, 2))
    cfClient.close()
    process.exit(0)
  }).catch(e => {
    cleanup()
    console.error(JSON.stringify({ error: e.message }))
    cfClient.close()
    process.exit(1)
  })
} else {
  const startupDelay = 15000
  log.info(`waiting ${startupDelay / 1000}s for old instance to shutdown...`)
  await new Promise(r => setTimeout(r, startupDelay))

  const webhookDomain = process.env.WEBHOOK_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN
  const port = parseInt(process.env.PORT || '3000', 10)

  if (webhookDomain) {
    bot.launch({
      webhook: {
        domain: webhookDomain,
        port,
      },
    })
    log.success(`bot started in webhook mode`)
    log.info(`webhook domain: ${webhookDomain}`)
    log.info(`listening on port: ${port}`)
    log.info(`webhook URL: https://${webhookDomain}${bot.secretPathComponent()}`)
  } else {
    bot.launch()
    log.success('bot started in long-polling mode')
    log.info('set RAILWAY_PUBLIC_DOMAIN or WEBHOOK_DOMAIN to enable webhook mode')
  }

  printState()
  resumeSessions()
}

process.on('SIGINT', async () => {
  for (const id of Object.keys(pollingSessions)) await stopPolling(id)
  cfClient.close()
  if (redis) { saveData(); saveSeenMessages(); await redis.quit() }
  fs.rmSync(path.dirname(WORKER_SCRIPT), { recursive: true, force: true })
  bot.stop('SIGINT')
  process.exit(0)
})
process.on('SIGTERM', async () => {
  for (const id of Object.keys(pollingSessions)) await stopPolling(id)
  cfClient.close()
  if (redis) { saveData(); saveSeenMessages(); await redis.quit() }
  fs.rmSync(path.dirname(WORKER_SCRIPT), { recursive: true, force: true })
  bot.stop('SIGTERM')
  process.exit(0)
})
