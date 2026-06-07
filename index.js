process.noDeprecation = true

import { Telegraf, Markup } from 'telegraf'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = path.join(__dirname, '.env')
const DATA_FILE_DIR = process.env.DATA_FILE_DIR || __dirname
const DATA_FILE = path.join(DATA_FILE_DIR, 'data.json')

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
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || 'Abuhider123@@@'
const AUTH_USERS = (process.env.AUTHORIZED_USERS || '').split(',').map(Number).filter(Boolean)
const AUTHORIZED_USERS = new Set(AUTH_USERS)
const MAX_NUMBERS_PER_ACCOUNT = 3

if (!TG_TOKEN) { console.error('TG_TOKEN missing in .env'); process.exit(1) }
if (!MULTIBOT_KEY) { console.error('MULTIBOT_KEY missing in .env'); process.exit(1) }
if (AUTHORIZED_USERS.size === 0) { console.error('AUTHORIZED_USERS missing in .env'); process.exit(1) }

const API = 'https://2no.pl'
const KILOMAIL_API = 'https://kilomail.vercel.app/api'
const TURNSTILE_SITEKEY = '0x4AAAAAAAh6YYTPTzEcN3Ep'

let data = { proxy: null, users: {} }
if (fs.existsSync(DATA_FILE)) {
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) } catch {}
}
if (!data.users) data.users = {}
if (!data.proxy) data.proxy = null
if (!data.stats) data.stats = { captchaSolved: 0, numbersGenerated: 0, messagesReceived: 0 }
if (!data.savedSessions) data.savedSessions = {}

function saveData() {
  const total = { captchaSolved: 0, numbersGenerated: 0, messagesReceived: 0 }
  for (const u of Object.values(data.users)) {
    total.captchaSolved += u.captchaSolved || 0
    total.numbersGenerated += u.numbersGenerated || 0
    total.messagesReceived += u.messagesReceived || 0
  }
  data.stats = total
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
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

async function testProxy(proxy) {
  let browser
  try {
    browser = await chromium.launch({ headless: true, proxy, args: ['--no-sandbox'] })
    const page = await browser.newPage()
    log.info('testing proxy, fetching IP', 'PROXY')
    const resp = await page.goto('https://httpbin.org/ip', { timeout: 15000 })
    const json = await resp.json()
    await page.close()
    return { ok: true, ip: json.origin }
  } catch {
    return { ok: false }
  } finally {
    if (browser) try { await browser.close() } catch {}
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
    else if (pollBrowsers[id]) state = 'polling'
    const nums = (u.numbers || []).length
    log.info(`${id} ${state} ${nums} numbers`, 'USER')
  }
  console.log('')
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const isTest = process.argv.includes('--test')
const testEmailIdx = process.argv.indexOf('--email')
const testEmail = testEmailIdx >= 0 ? process.argv[testEmailIdx + 1] : null
const testTimeoutIdx = process.argv.indexOf('--timeout')
const testTimeout = testTimeoutIdx >= 0 ? parseInt(process.argv[testTimeoutIdx + 1], 10) * 1000 : 300000
const testLogin = process.argv.includes('--login')
const testCountIdx = process.argv.indexOf('--count')
const testCount = testCountIdx >= 0 ? parseInt(process.argv[testCountIdx + 1], 10) : MAX_NUMBERS_PER_ACCOUNT

const sessions = {}
const pollTimers = {}
const pollBrowsers = {}
const seenMessages = {}
const processing = {}
const monitorMessages = {}
const autoStopTimers = {}
const reAuthLocks = {}
const pendingProxy = {}
const pendingImport = {}

function rand(len = 8) {
  return Array.from({ length: len }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
}

const _ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false })

const log = {
  info: (msg, tag) => console.log(tag != null ? `${chalk.gray(`${_ts()}`)} ${chalk.cyan(String(tag))} ${chalk.white(msg)}` : `${chalk.gray(`${_ts()}`)} ${chalk.white(msg)}`),
  success: (msg, tag) => console.log(tag != null ? `${chalk.gray(`${_ts()}`)} ${chalk.cyan(String(tag))} ${chalk.white(msg)}` : `${chalk.gray(`${_ts()}`)} ${chalk.white(msg)}`),
  error: (msg, tag) => console.log(tag != null ? `${chalk.gray(`${_ts()}`)} ${chalk.cyan(String(tag))} ${chalk.white(msg)}` : `${chalk.gray(`${_ts()}`)} ${chalk.white(msg)}`),
  warning: (msg, tag) => console.log(tag != null ? `${chalk.gray(`${_ts()}`)} ${chalk.cyan(String(tag))} ${chalk.white(msg)}` : `${chalk.gray(`${_ts()}`)} ${chalk.white(msg)}`),
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
    [Markup.button.callback('Back', 'settings_back')],
  ])
}

function dataMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Export', 'data_export')],
    [Markup.button.callback('Import', 'data_import')],
    [Markup.button.callback('Back', 'settings')],
  ])
}

function countMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('1', 'set_count_1'), Markup.button.callback('2', 'set_count_2'), Markup.button.callback('3', 'set_count_3')],
    [Markup.button.callback('Back', 'settings')],
  ])
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

async function browserEval(page, body) {
  return page.evaluate(async ({ url, body }) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return r.json()
  }, { url: API, body })
}

async function browserEvalAuth(page, token, body) {
  return page.evaluate(async ({ url, token, body }) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-token': token },
      body: JSON.stringify(body),
    })
    return r.json()
  }, { url: API, token, body })
}

async function launchBrowser() {
  const proxy = getProxy()
  const proxyInfo = proxy ? `${proxy.server}` : 'none'
  log.info(`launching browser, proxy ${proxyInfo}`, 'BROWSER')
  try {
    const opts = proxy ? { headless: false, proxy } : { headless: false }
    const browser = await chromium.launch(opts)
    const page = await browser.newPage()
    await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded' })
    log.success('browser ready', 'BROWSER')
    return { browser, page }
  } catch (e) {
    if (proxy) log.error(`proxy failed: ${e.message}`, 'PROXY')
    throw e
  }
}

function createCaptchaSolver(getPageUrl, chatId, maxConcurrent = 2) {
  const queue = []
  let active = 0
  const CAPTCHA_TTL = 250000

  async function _solveOne(entry) {
    active++
    log.info(`captcha solving started, ${queue.length} queued, ${active} active`, chatId)
    try {
      const token = await solveTurnstile(TURNSTILE_SITEKEY, getPageUrl())
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

async function buyNumbers(page, token, count, solver, captchaPromises, chatId, onProgress) {
  const bought = []
  for (let i = 0; i < count; i++) {
    log.info(`buying number ${i + 1}/${count}`, chatId)
    if (onProgress) onProgress('progress', `Buying number ${i + 1}/${count}`)

    const avail = await browserEvalAuth(page, token, { id: 310 })
    if (!avail.result || !avail.result.length) {
      log.warning(`no numbers available for purchase ${i + 1}, stopping`, chatId)
      break
    }
    const toBuy = avail.result[0]
    log.info(`available: ${toBuy.number} id ${toBuy.id}`, chatId)

    const { token: captchaToken, solvedAt } = await captchaPromises[i]
    const validToken = Date.now() - solvedAt > 250000 ? await solver.getValidToken() : captchaToken
    log.info('captcha ready, buying', chatId)

    const buyRes = await browserEvalAuth(page, token, {
      id: 301,
      query: {
        number_id: toBuy.id, name: '', color: '#4893EC',
        availability_days: [1, 2, 3, 4, 5, 6, 7],
        hour_from: '00:00:00.000Z', hour_to: '23:59:59.999Z',
        right_to_transfer_number: true, marketing: false,
        response_key: validToken,
      },
    })
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

async function registerAndGetNumbers(count, chatId, onProgress) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const email = `${rand(8)}@kilolabs.space`
    const password = DEFAULT_PASSWORD
    log.info(`registration attempt ${attempt + 1} with email ${email}`, chatId)
    if (onProgress) onProgress('progress', `Creating account attempt ${attempt + 1} of 3`)
    const { browser, page } = await launchBrowser()

    const closeBrowser = () => { log.info('closing browser', chatId); try { browser.close() } catch {} }

    const solver = createCaptchaSolver(() => page.url(), chatId, count)
    const captchaPromises = solver.preQueue(count)

    const reg = await browserEval(page, { id: 103, query: { email, password } })
    if (!reg.success) {
      log.error(`registration failed for ${email}: ${JSON.stringify(reg)}`, chatId)
      closeBrowser()
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
    if (!msg) { log.warning('verification email not received', chatId); closeBrowser(); continue }
    log.success(`verification email arrived: ${msg.subject}`, chatId)
    if (onProgress) onProgress('progress', 'Verification email received, verifying')

    log.info('fetching email body', chatId)
    const body = await fetch(`${KILOMAIL_API}/inbox/${encodeURIComponent(email)}/${msg.id}`).then(r => r.json())
    const html = (body && body.html) || ''
    const m = html.match(/https:\/\/2nd-no\.com\/auth\/create-account\/\?[^\s"<]+/)
    const verifyLink = m ? m[0].replace(/&amp;/g, '&') : null
    if (!verifyLink) { log.warning('no verify link in email', chatId); closeBrowser(); continue }
    log.info('clicking verify link', chatId)
    if (onProgress) onProgress('progress', 'Clicking verification link')

    log.info('navigating to verify link', chatId)
    await page.goto(verifyLink)
    log.info('page loaded, clicking login button', chatId)
    await page.waitForSelector('button:has-text("Go to login page")', { timeout: 20000 })
    await page.locator('button:has-text("Go to login page")').click()
    await page.waitForTimeout(5000)

    log.info('getting auth token', chatId)
    if (onProgress) onProgress('progress', 'Getting auth token')
    const loginRes = await browserEval(page, { id: 101, query: { email, password } })
    const token = (loginRes && loginRes.token) || ''
    if (!token) { log.error('failed to get auth token after registration', chatId); closeBrowser(); continue }
    log.success('auth token obtained', chatId)

    const maxBuy = Math.min(count, MAX_NUMBERS_PER_ACCOUNT)
    const bought = await buyNumbers(page, token, maxBuy, solver, captchaPromises, chatId, onProgress)

    if (bought.length === 0) { log.warning('no numbers bought, retrying', chatId); closeBrowser(); continue }

    log.success(`registration complete, ${bought.length} numbers`, chatId)
    if (chatId) {
      const st = userStats(chatId)
      if (!st.emails) st.emails = []
      st.emails.push({ email, createdAt: new Date().toISOString() })
      saveData()
    }
    await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    return { email, password, token, numbers: bought, browser, page }
  }
  throw new Error('registration failed after 3 attempts')
}

async function loginAndGetNumbers(session, count, chatId, onProgress) {
  log.info('logging into existing account', chatId)
  log.info(`email ${session.email}`, chatId)
  if (onProgress) onProgress('progress', 'Logging in')
  const { browser, page } = await launchBrowser()

  const solver = createCaptchaSolver(() => page.url(), chatId, count)

  log.info('performing login', chatId)
  const loginRes = await browserEval(page, { id: 101, query: { email: session.email, password: session.password } })
  const token = (loginRes && loginRes.token) || ''
  if (!token) { log.error('login failed: no token returned', chatId); await browser.close(); throw new Error('login failed: no token returned') }
  log.success('login successful', chatId)
  if (onProgress) onProgress('progress', 'Login successful, checking numbers')

  const myNums = await browserEvalAuth(page, token, { id: 311 })
  const existing = myNums.result || []
  log.info(`existing numbers: ${existing.length}`, chatId)

  const needCount = Math.max(0, Math.min(count, MAX_NUMBERS_PER_ACCOUNT) - existing.length)

  if (needCount === 0) {
    log.info(`already have ${existing.length} numbers, using existing`, chatId)
    if (onProgress) onProgress('progress', 'Using existing numbers')
    await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    const numbers = existing.map(e => ({ number: e.number, number_id: e.number_id }))
    if (onProgress) {
      for (const n of numbers) onProgress('number', `+48 ${n.number}`)
    }
    return { token, numbers, browser, page }
  }

  log.info(`need to buy ${needCount} more numbers`, chatId)
  if (onProgress) onProgress('progress', `Need to buy ${needCount} more numbers`)
  const captchaPromises = solver.preQueue(needCount)

  const bought = await buyNumbers(page, token, needCount, solver, captchaPromises, chatId, onProgress)
  const allNumbers = [...existing.map(e => ({ number: e.number, number_id: e.number_id })), ...bought]

  await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
  return { token, numbers: allNumbers, browser, page }
}

async function stopPolling(chatId) {
  if (pollTimers[chatId]) {
    log.info('stopping SMS poll timer', chatId)
    clearInterval(pollTimers[chatId])
    delete pollTimers[chatId]
  }
  if (pollBrowsers[chatId]) {
    log.info('closing poll browser', chatId)
    try { await pollBrowsers[chatId].browser.close() } catch {}
    delete pollBrowsers[chatId]
  }
  if (autoStopTimers[chatId]) {
    clearTimeout(autoStopTimers[chatId])
    delete autoStopTimers[chatId]
  }
  printState()
}

async function pollApi(page, token, body) {
  try {
    return await page.evaluate(async ({ url, token, body }) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth-token': token },
        body: JSON.stringify(body),
      })
      return r.json()
    }, { url: API, token, body })
  } catch (e) {
    if (e.message && e.message.includes('Execution context was destroyed')) {
      await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
      return await page.evaluate(async ({ url, token, body }) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-auth-token': token },
          body: JSON.stringify(body),
        })
        return r.json()
      }, { url: API, token, body })
    }
    throw e
  }
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

async function startPolling(chatId, session, page) {
  await stopPolling(chatId)
  seenMessages[chatId] = new Set()
  pollBrowsers[chatId] = { browser: page.context().browser(), page }

  log.info(`started SMS polling for +48 ${session.numbers.map(n => n.number).join(', ')}`, chatId)

  let pollCount = 0
  pollTimers[chatId] = setInterval(async () => {
    pollCount++
    try {
      const msgs = await pollApi(page, session.token, {
        id: 414,
        query: { offset: 0, limit: 10, order_by: [{ field: 'created_at', order: 'DESC' }] },
      })

      if (msgs.error === 1003 && msgs.code === 401) {
        log.warning('token expired, attempting re-login', chatId)
        if (reAuthLocks[chatId]) { return }
        reAuthLocks[chatId] = true
        try {
          let newToken
          try {
            newToken = await page.evaluate(async ({ url, email, password }) => {
              const r = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: 101, query: { email, password } }),
              })
              const data = await r.json()
              return data.token || null
            }, { url: API, email: session.email, password: session.password })
          } catch (ctxErr) {
            if (ctxErr.message && ctxErr.message.includes('Execution context was destroyed')) {
              await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
              newToken = await page.evaluate(async ({ url, email, password }) => {
                const r = await fetch(url, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ id: 101, query: { email, password } }),
                })
                const data = await r.json()
                return data.token || null
              }, { url: API, email: session.email, password: session.password })
            } else { throw ctxErr }
          }
          if (!newToken) throw new Error('re-login failed')
          session.token = newToken
          sessions[chatId] = session
          log.success('token refreshed', chatId)
        } catch (e) {
          log.error(`re-login failed: ${e.message}`, chatId)
        } finally {
          delete reAuthLocks[chatId]
        }
        return
      }

      const numberIds = (session.numbers || []).map(n => n.number_id)
      const forNumbers = (msgs.result || []).filter(m => numberIds.includes(m.number_id))

      if (!forNumbers.length && pollCount % 6 === 0) {
        log.info(`poll OK, ${(msgs.result || []).length} total messages. listening`, chatId)
      }

      for (const m of forNumbers) {
        const key = m.id || (m.body ? m.body.slice(0, 100) : '')
        if (seenMessages[chatId] && seenMessages[chatId].has(key)) continue
        seenMessages[chatId].add(key)

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
  }, 5000)
  autoStopTimers[chatId] = setTimeout(() => {
    log.info('2-hour auto-stop triggered', chatId)
    stopPolling(chatId)
    const msgId = monitorMessages[chatId]
    if (msgId) {
      const resumeBtn = [[{ text: 'Resume Monitoring', callback_data: `start_monitor_${chatId}_${msgId}` }]]
      bot.telegram.editMessageText(chatId, msgId, undefined,
        '<b>Monitoring auto-stopped (2h limit)</b>\n\nClick Resume to continue monitoring.',
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: resumeBtn } }
      ).catch(() => {})
    }
    printState()
  }, 7200000)
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

async function processGetNumber(ctx, count) {
  const chatId = ctx.chat.id
  if (processing[chatId]) {
    await ctx.answerCbQuery('Already processing your request')
    return
  }
  const lastReq = data.users[chatId]?.lastNumberRequest
  if (lastReq && Date.now() - lastReq < 7200000) {
    const wait = Math.ceil((7200000 - (Date.now() - lastReq)) / 60000)
    await ctx.answerCbQuery(`Wait ${wait}min before requesting new numbers`)
    return
  }
  log.info('processing flag set', chatId)
  processing[chatId] = true
  await ctx.answerCbQuery()
  const msg = await ctx.reply(`Getting ${count} numbers, this may take a minute`)
  log.info(`user requested ${count} numbers`, chatId)
  log.info('launching background task', chatId)

  const numbersBuffer = []
  let lastMsgText = ''

  const onProgress = (type, data) => {
    try {
      if (type === 'progress') {
        lastMsgText = data
        ctx.telegram.editMessageText(chatId, msg.message_id, undefined, data).catch(() => {})
      } else if (type === 'number') {
        numbersBuffer.push(`<code>${data}</code>`)
        const prefix = numbersBuffer.length >= count ? '<b>All numbers ready!</b>' : `<b>Got ${numbersBuffer.length}/${count}:</b>`
        const text = `${prefix}\n${numbersBuffer.join('\n')}`
        lastMsgText = text
        ctx.telegram.editMessageText(chatId, msg.message_id, undefined, text, { parse_mode: 'HTML' }).catch(() => {})
      }
    } catch {}
  }

  ;(async () => {
    try {
      let session = sessions[chatId]
      let pollPage

      if (!session) {
        log.info('no existing session, starting registration', chatId)
        const result = await registerAndGetNumbers(count, chatId, onProgress)
        session = {
          email: result.email,
          password: DEFAULT_PASSWORD,
          token: result.token,
          numbers: result.numbers,
          chatId: chatId,
        }
        pollPage = result.page
        sessions[chatId] = session
        data.savedSessions[chatId] = { email: session.email, password: session.password, numbers: session.numbers, chatId }
        saveData()
        log.success(`account created, numbers: ${result.numbers.length}`, chatId)
      } else {
        session.chatId = chatId
        log.info('existing session found, logging in', chatId)
        session.email = session.email || session._email
        const result = await loginAndGetNumbers(session, count, chatId, onProgress)
        session.token = result.token
        session.numbers = result.numbers
        pollPage = result.page
        sessions[chatId] = session
        data.savedSessions[chatId] = { email: session.email, password: session.password, numbers: session.numbers, chatId }
        saveData()
        log.success(`logged in, numbers: ${result.numbers.length}`, chatId)
      }

      await stopPolling(chatId)

      const st = userStats(chatId)
      st.lastNumberRequest = Date.now()
      saveData()

      const numList = session.numbers.map(n => `<code>+48${n.number}</code>`).join('\n')
      const stopBtn = [[{ text: 'Stop Monitoring', callback_data: `stop_${chatId}_${msg.message_id}` }]]
      monitorMessages[chatId] = msg.message_id
      await ctx.telegram.editMessageText(chatId, msg.message_id, undefined,
        `<b>Your numbers ${session.numbers.length}:</b>\n${numList}\n\nMonitoring for incoming SMS`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: stopBtn } }
      ).catch(() => {})

      await startPolling(chatId, session, pollPage)
      printState()
    } catch (e) {
      log.error(`error: ${e.message}`, chatId)
      try {
        const proxy = getProxy()
        if (proxy) {
          const test = await testProxy(proxy)
          if (!test.ok) {
            ctx.reply('⚠️ Your proxy is not working. Please update it in Settings → Set Proxy.')
          } else {
            ctx.reply(`❌ Browser error: ${e.message}`)
          }
        } else {
          ctx.reply(`❌ Error: ${e.message}`)
        }
        await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, `Error: ${e.message}`)
      } catch {}
    } finally {
      log.info('processing flag cleared', chatId)
      delete processing[chatId]
    }
  })()
}

async function resumeSessions() {
  const saved = data.savedSessions || {}
  const entries = Object.entries(saved)
  if (!entries.length) return
  log.info(`resuming ${entries.length} saved session(s)`)
  for (const [chatId, s] of entries) {
    if (sessions[chatId]) continue
    ;(async () => {
      try {
        const proxy = getProxy()
        const proxyInfo = proxy ? `${proxy.server}` : 'none'
        log.info(`resuming session ${chatId}, ${s.numbers.length} number(s): ${s.numbers.map(n => n.number).join(', ')}`, chatId)
        const opts = proxy ? { headless: false, proxy } : { headless: false }
        const browser = await chromium.launch(opts)
        const page = await browser.newPage()
        await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
        const loginRes = await page.evaluate(async ({ url, email, password }) => {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 101, query: { email, password } }),
          })
          return r.json()
        }, { url: API, email: s.email, password: s.password })
        const token = (loginRes && loginRes.token) || ''
        if (!token) { log.error(`resume login failed for ${chatId}`, chatId); await browser.close(); return }
        const session = { email: s.email, password: s.password, token, numbers: s.numbers, chatId }
        sessions[chatId] = session
        await startPolling(chatId, session, page)
        log.success(`session resumed for ${chatId}`, chatId)
        printState()
      } catch (e) {
        log.error(`resume failed for ${chatId}: ${e.message}`, chatId)
      }
    })()
  }
}

let bot
if (!isTest) {
bot = new Telegraf(TG_TOKEN)

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
    if (!parsed) {
      return ctx.reply('Invalid proxy format. Use: http://user:pass@host:port')
    }
    const result = await testProxy(parsed)
    if (!result.ok) {
      return ctx.reply('Proxy test failed, address may be invalid or unreachable')
    }
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
  if (sessions[chatId]) sessions[chatId].numbers = []
  saveData()
  const resumeBtn = [[{ text: 'Resume Monitoring', callback_data: `start_monitor_${chatId}_${msgId}` }]]
  await ctx.telegram.editMessageText(chatId, msgId, undefined,
    '<b>Monitoring stopped</b>\n\nClick Resume to continue monitoring.',
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: resumeBtn } }
  ).catch(() => {})
  printState()
})

bot.action(/stop_cancel_(\d+)_(\d+)/, async (ctx) => {
  const chatId = Number(ctx.match[1])
  const msgId = Number(ctx.match[2])
  if (ctx.chat.id !== chatId) return ctx.answerCbQuery('Not your session')
  await ctx.answerCbQuery()
  const session = sessions[chatId]
  if (session && session.numbers.length) {
    const numList = session.numbers.map(n => `<code>+48${n.number}</code>`).join('\n')
    const stopBtn = [[{ text: 'Stop Monitoring', callback_data: `stop_${chatId}_${msgId}` }]]
    await ctx.telegram.editMessageText(chatId, msgId, undefined,
      `<b>Your numbers ${session.numbers.length}:</b>\n${numList}\n\nMonitoring for incoming SMS`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: stopBtn } }
    ).catch(() => {})
  } else {
    await ctx.editMessageReplyMarkup({})
  }
})

bot.action(/start_monitor_(\d+)_(\d+)/, async (ctx) => {
  const chatId = Number(ctx.match[1])
  const msgId = Number(ctx.match[2])
  if (ctx.chat.id !== chatId) return ctx.answerCbQuery('Not your session')
  await ctx.answerCbQuery()
  const session = sessions[chatId]
  if (!session || !session.numbers.length) {
    await ctx.telegram.editMessageText(chatId, msgId, undefined,
      'No numbers to monitor.'
    ).catch(() => {})
    return ctx.reply('Choose an option:', mainMenu())
  }
  const oldest = session.numbers.reduce((min, n) => Math.min(min, n.created_at || Infinity), Infinity) * 1000
  if (oldest && Date.now() - oldest > 86400000) {
    await ctx.telegram.editMessageText(chatId, msgId, undefined,
      'Numbers expired (24h limit). Create new numbers.'
    ).catch(() => {})
    return ctx.reply('Choose an option:', mainMenu())
  }
  try {
    const proxy = getProxy()
    const opts = proxy ? { headless: false, proxy } : { headless: false }
    const browser = await chromium.launch(opts)
    const page = await browser.newPage()
    await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    const loginRes = await page.evaluate(async ({ url, email, password }) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 101, query: { email, password } }),
      })
      return r.json()
    }, { url: API, email: session.email, password: session.password })
    const token = (loginRes && loginRes.token) || ''
    if (!token) throw new Error('login failed')
    session.token = token
    sessions[chatId] = session
    await startPolling(chatId, session, page)
    monitorMessages[chatId] = msgId
    const numList = session.numbers.map(n => `<code>+48${n.number}</code>`).join('\n')
    const stopBtn = [[{ text: 'Stop Monitoring', callback_data: `stop_${chatId}_${msgId}` }]]
    await ctx.telegram.editMessageText(chatId, msgId, undefined,
      `<b>Your numbers ${session.numbers.length}:</b>\n${numList}\n\nMonitoring for incoming SMS`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: stopBtn } }
    ).catch(() => {})
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

bot.action('settings_testproxy', async (ctx) => {
  await ctx.answerCbQuery()
  const chatId = ctx.chat.id
  const proxy = getProxy()
  if (!proxy) {
    return ctx.reply('No proxy set')
  }
  const result = await testProxy(proxy)
  if (result.ok) {
    log.success(`proxy test ok, ip ${result.ip}`, chatId)
    return ctx.reply(`Proxy is working, IP: ${result.ip}`)
  }
  log.error('proxy test failed', chatId)
  return ctx.reply('Proxy test failed, provide a new one')
})

bot.action('settings_proxy', async (ctx) => {
  const chatId = ctx.chat.id
  log.info('requested proxy change', chatId)
  await ctx.answerCbQuery()
  const proxy = getProxy()
  const currentInfo = proxy ? `Current: ${proxy.username ? proxy.server.replace('://', `://${proxy.username}:${proxy.password}@`) : proxy.server}` : 'No proxy set'
  pendingProxy[ctx.chat.id] = true
  await ctx.editMessageText(`Send proxy URL in format:\nhttp://user:pass@host:port\n\n${currentInfo}`, 
    Markup.inlineKeyboard([[Markup.button.callback('Back', 'settings')]]))
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
  await ctx.editMessageText(`Current count: ${cur}. Choose new count:`, countMenu())
})

for (let n = 1; n <= 3; n++) {
  bot.action(`set_count_${n}`, async (ctx) => {
    const chatId = ctx.chat.id
    setUserDefaultNumbers(chatId, n)
    log.info(`default count set to ${n}`, chatId)
    await ctx.answerCbQuery(`Default set to ${n}`)
    await ctx.editMessageText(`Default set to ${n}`, settingsMenu())
  })
}

bot.action('get_number', async (ctx) => {
  const chatId = ctx.chat.id
  const count = getUserDefaultNumbers(chatId)
  await processGetNumber(ctx, count)
})

bot.launch()
log.success('bot started')
printState()
resumeSessions()

process.on('SIGINT', async () => {
  for (const id of Object.keys(pollBrowsers)) await stopPolling(id)
  bot.stop('SIGINT')
  process.exit(0)
})
process.on('SIGTERM', async () => {
  for (const id of Object.keys(pollBrowsers)) await stopPolling(id)
  bot.stop('SIGTERM')
  process.exit(0)
})
} else {
;(async () => {
  const chatId = 'test'
  log.info('running in test mode', chatId)
  let session, pollPage
  const count = testCount

  if (testLogin) {
    if (!testEmail) throw new Error('--login requires --email')
    const found = Object.values(sessions).find(s => s.email === testEmail)
    if (!found) throw new Error(`No saved session for ${testEmail}`)
    log.info(`using existing session for ${testEmail}`, chatId)
    const result = await loginAndGetNumbers({ ...found, chatId }, count, chatId, null)
    session = { ...found, ...result, chatId }
    pollPage = result.page
  } else {
    const email = testEmail || `${rand(8)}@kilolabs.space`
    log.info(`email: ${email}`, chatId)
    const result = await registerAndGetNumbers(count, chatId, null)
    session = { email, password: DEFAULT_PASSWORD, token: result.token, numbers: result.numbers, chatId }
    pollPage = result.page
    sessions[chatId] = session
  }

  const numList = session.numbers.map(n => `+48 ${n.number}`).join(', ')
  log.info(`numbers ${session.numbers.length}: ${numList}`, chatId)
  log.info(`polling for SMS for ${testTimeout / 1000}s, press Ctrl+C to stop`, chatId)

  await startPolling(chatId, session, pollPage)
  await sleep(testTimeout)
  await stopPolling(chatId)
  log.info('test timeout reached', chatId)
  process.exit(0)
})().catch((e) => {
  log.error(`fatal error: ${e.message}`, 'test')
  process.exit(1)
})
}
