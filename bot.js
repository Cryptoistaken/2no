process.noDeprecation = true

const { Telegraf, Markup } = require('telegraf')
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const API = 'https://2no.pl'
const KILOMAIL_API = 'https://kilomail.vercel.app/api'
const TURNSTILE_SITEKEY = '0x4AAAAAAAh6YYTPTzEcN3Ep'
const MULTIBOT_KEY = process.env.MULTIBOT_KEY || 'w0w8mPygHI6debcLL2UAqq35otYn234X'
const DEFAULT_PASSWORD = 'Abuhider123@@@'
const AUTHORIZED_USERS = new Set([1772093705, 8447133985])
const PROXY = { server: 'http://change4.owlproxy.com:7778', username: 'W4FMnPWKP050_custom_zone_ve', password: '3185836' }
const TG_TOKEN = process.env.TG_TOKEN || '8536889060:AAGCmUGiKtie1rV2ei0XswyceGuFV2CKHVQ'
const CONFIG_FILE = path.join(__dirname, 'config.json')
const MAX_NUMBERS_PER_ACCOUNT = 3

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

let config = {}
if (fs.existsSync(CONFIG_FILE)) {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
}
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)) }

const pollTimers = {}
const pollBrowsers = {}
const seenMessages = {}
const processing = {}
const reAuthLocks = {}

function rand(len = 8) {
  return Array.from({ length: len }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
}

function now() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

function log(chatId, msg) {
  const tag = chatId ? `[${chatId}]` : '[BOT]'
  console.log(`${now()} ${tag} ${msg}`)
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
  for (let i = 0; i < 60; i++) {
    await sleep(3000)
    const cr = await fetch(`https://api.multibot.cloud/res.php?key=${MULTIBOT_KEY}&id=${taskId}&json=1`)
    const ct = await cr.text()
    let c
    try { c = JSON.parse(ct) } catch { throw new Error(`multibot poll parse failed: ${ct}`) }
    if (c.status === 1) return c.request || c.value
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
  const browser = await chromium.launch({ headless: false, proxy: PROXY })
  const page = await browser.newPage()
  await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded' })
  return { browser, page }
}

// Captcha solver with background pre-solving queue
function createCaptchaSolver(getPageUrl) {
  const queue = []
  let solving = false

  async function _solveNext() {
    if (solving) return
    solving = true
    try {
      while (queue.length > 0) {
        const entry = queue[0]
        try {
          const token = await solveTurnstile(TURNSTILE_SITEKEY, getPageUrl())
          entry.resolve(token)
        } catch (e) {
          entry.reject(e)
        }
        queue.shift()
      }
    } finally {
      solving = false
    }
  }

  return {
    queueCaptcha() {
      return new Promise((resolve, reject) => {
        queue.push({ resolve, reject })
        _solveNext()
      })
    },
    getPendingCount() { return queue.length },
  }
}

async function buyNumbers(page, token, count, solver, logTag) {
  const bought = []
  for (let i = 0; i < count; i++) {
    log(logTag, `Buying number ${i + 1}/${count}...`)

    const avail = await browserEvalAuth(page, token, { id: 310 })
    if (!avail.result || !avail.result.length) {
      log(logTag, `No numbers available for purchase ${i + 1}, stopping`)
      break
    }
    const toBuy = avail.result[0]
    log(logTag, `Available: ${toBuy.number} (id:${toBuy.id})`)

    log(logTag, 'Waiting for captcha token...')
    const captchaToken = await solver.queueCaptcha()
    log(logTag, 'Captcha ready, buying...')

    const buyRes = await browserEvalAuth(page, token, {
      id: 301,
      query: {
        number_id: toBuy.id, name: '', color: '#4893EC',
        availability_days: [1, 2, 3, 4, 5, 6, 7],
        hour_from: '00:00:00.000Z', hour_to: '23:59:59.999Z',
        right_to_transfer_number: true, marketing: false,
        response_key: captchaToken,
      },
    })
    if (!buyRes.success) {
      log(logTag, `Buy ${i + 1} failed: ${JSON.stringify(buyRes)}`)
      break
    }
    log(logTag, `Number ${i + 1} purchased: ${toBuy.number}`)
    bought.push({ number: toBuy.number, number_id: toBuy.id })

    // Queue next captcha in background while we process this purchase
    if (i + 1 < count) {
      solver.queueCaptcha()
    }
  }
  return bought
}

async function registerAndGetNumbers(count, logTag) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const email = `${rand(8)}@kilolabs.space`
    const password = DEFAULT_PASSWORD
    log(logTag, `Registration attempt ${attempt + 1} with email ${email}`)
    const { browser, page } = await launchBrowser()

    const closeBrowser = () => { try { browser.close() } catch {} }

    // Create captcha solver and pre-queue first captcha immediately
    const solver = createCaptchaSolver(() => page.url())
    solver.queueCaptcha()

    const reg = await browserEval(page, { id: 103, query: { email, password } })
    if (!reg.success) {
      log(logTag, `Registration failed for ${email}: ${JSON.stringify(reg)}`)
      closeBrowser()
      if (reg.error === 'EmailExists') continue
      throw new Error(`register failed: ${JSON.stringify(reg)}`)
    }
    log(logTag, `Account created: ${email}`)

    // Queue second captcha while we wait for email
    solver.queueCaptcha()

    log(logTag, 'Waiting for verification email...')
    let msg = null
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const inbox = await fetch(`${KILOMAIL_API}/inbox/${encodeURIComponent(email)}`).then(r => r.ok ? r.json() : [])
      if (Array.isArray(inbox) && inbox.length) { msg = inbox[0]; break }
      await sleep(2000)
    }
    if (!msg) { log(logTag, 'Verification email not received'); closeBrowser(); continue }
    log(logTag, `Verification email arrived: ${msg.subject}`)

    const body = await fetch(`${KILOMAIL_API}/inbox/${encodeURIComponent(email)}/${msg.id}`).then(r => r.json())
    const html = (body && body.html) || ''
    const m = html.match(/https:\/\/2nd-no\.com\/auth\/create-account\/\?[^\s"<]+/)
    const verifyLink = m ? m[0].replace(/&amp;/g, '&') : null
    if (!verifyLink) { log(logTag, 'No verify link in email'); closeBrowser(); continue }
    log(logTag, 'Clicking verify link...')

    await page.goto(verifyLink)
    await page.waitForSelector('button:has-text("Go to login page")', { timeout: 20000 })
    await page.locator('button:has-text("Go to login page")').click()
    await page.waitForTimeout(5000)

    log(logTag, 'Getting auth token...')
    const loginRes = await browserEval(page, { id: 101, query: { email, password } })
    const token = (loginRes && loginRes.token) || ''
    if (!token) { log(logTag, 'Failed to get auth token after registration'); closeBrowser(); continue }
    log(logTag, 'Auth token obtained')

    const maxBuy = Math.min(count, MAX_NUMBERS_PER_ACCOUNT)
    const bought = await buyNumbers(page, token, maxBuy, solver, logTag)

    if (bought.length === 0) { closeBrowser(); continue }

    await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    return { email, password, token, numbers: bought, browser, page }
  }
  throw new Error('registration failed after 3 attempts')
}

async function loginAndGetNumbers(session, count, logTag) {
  log(logTag, 'Logging into existing account...')
  const { browser, page } = await launchBrowser()

  const solver = createCaptchaSolver(() => page.url())

  const loginRes = await browserEval(page, { id: 101, query: { email: session.email, password: session.password } })
  const token = (loginRes && loginRes.token) || ''
  if (!token) { await browser.close(); throw new Error('login failed: no token returned') }
  log(logTag, 'Login successful')

  // Check existing numbers
  const myNums = await browserEvalAuth(page, token, { id: 311 })
  const existing = myNums.result || []
  log(logTag, `Existing numbers: ${existing.length}`)

  const needCount = Math.max(0, Math.min(count, MAX_NUMBERS_PER_ACCOUNT) - existing.length)

  if (needCount === 0) {
    log(logTag, `Already have ${existing.length} numbers, using existing`)
    const n = existing[0]
    await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    return { token, numbers: existing.map(e => ({ number: e.number, number_id: e.number_id })), browser, page }
  }

  log(logTag, `Need to buy ${needCount} more number(s)`)

  // Pre-queue captcha before buying
  solver.queueCaptcha()

  const bought = await buyNumbers(page, token, needCount, solver, logTag)
  const allNumbers = [...existing.map(e => ({ number: e.number, number_id: e.number_id })), ...bought]

  await page.goto('https://2nd-no.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
  return { token, numbers: allNumbers, browser, page }
}

async function stopPolling(chatId) {
  if (pollTimers[chatId]) {
    clearInterval(pollTimers[chatId])
    delete pollTimers[chatId]
  }
  if (pollBrowsers[chatId]) {
    try { await pollBrowsers[chatId].browser.close() } catch {}
    delete pollBrowsers[chatId]
  }
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

async function startPolling(chatId, session, page) {
  await stopPolling(chatId)
  seenMessages[chatId] = new Set()
  pollBrowsers[chatId] = { browser: page.context().browser(), page }

  log(chatId, `Started SMS polling for +48 ${session.numbers.map(n => n.number).join(', ')}`)

  let pollCount = 0
  pollTimers[chatId] = setInterval(async () => {
    pollCount++
    try {
      const msgs = await pollApi(page, session.token, {
        id: 414,
        query: { offset: 0, limit: 10, order_by: [{ field: 'created_at', order: 'DESC' }] },
      })

      if (msgs.error === 1003 && msgs.code === 401) {
        log(chatId, 'Token expired, attempting re-login...')
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
          log(chatId, 'Token refreshed')
        } catch (e) {
          log(chatId, `Re-login failed: ${e.message}`)
        } finally {
          delete reAuthLocks[chatId]
        }
        return
      }

      const numberIds = (session.numbers || []).map(n => n.number_id)
      const forNumbers = (msgs.result || []).filter(m => numberIds.includes(m.number_id))

      if (!forNumbers.length && pollCount % 6 === 0) {
        log(chatId, `Poll OK — ${(msgs.result || []).length} total msgs. Listening...`)
      }

      for (const m of forNumbers) {
        const key = m.id || (m.body ? m.body.slice(0, 100) : '')
        if (seenMessages[chatId] && seenMessages[chatId].has(key)) continue
        seenMessages[chatId].add(key)

        const sender = m.from_number || m.from || 'unknown'
        const body = m.body || m.text || '(empty)'
        const time = m.created_at ? new Date(m.created_at).toLocaleString() : ''
        const num = (session.numbers || []).find(n => n.number_id === m.number_id)
        const numTag = num ? `[+48 ${num.number}]` : ''

        log(chatId, `SMS${numTag} from ${sender}: ${body.slice(0, 80)}`)
        if (typeof bot !== 'undefined') bot.telegram.sendMessage(chatId,
          `${numTag} From: ${sender}\nMessage: ${body}${time ? `\nTime: ${time}` : ''}`
        ).catch((e) => {
          log(chatId, `Telegram send failed: ${e.message}`)
        })
      }
    } catch (e) {
      log(chatId, `Polling error: ${e.message}`)
    }
  }, 5000)
}

function getUserDefaultNumbers(chatId) {
  const c = config[chatId]
  return (c && c.defaultNumbers) || MAX_NUMBERS_PER_ACCOUNT
}

function setUserDefaultNumbers(chatId, count) {
  if (!config[chatId]) config[chatId] = {}
  config[chatId].defaultNumbers = count
  saveConfig()
}

async function processGetNumber(ctx, count) {
  const chatId = ctx.chat.id
  if (processing[chatId]) {
    await ctx.answerCbQuery('Already processing your request...')
    return
  }
  processing[chatId] = true
  await ctx.answerCbQuery()
  const msg = await ctx.reply(`Getting ${count} number(s)... this may take a minute.`)
  log(chatId, `User requested ${count} number(s)`)

  try {
    let session = sessions[chatId]
    let pollPage

    if (!session) {
      await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, 'Creating account...')
      log(chatId, 'No existing session, starting registration')
      const result = await registerAndGetNumbers(count, chatId)
      session = {
        email: result.email,
        password: DEFAULT_PASSWORD,
        token: result.token,
        numbers: result.numbers,
        chatId: chatId,
      }
      pollPage = result.page
      sessions[chatId] = session
      log(chatId, `Account created, numbers: ${result.numbers.length}`)
    } else {
      session.chatId = chatId
      await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, 'Logging in...')
      log(chatId, 'Existing session found, logging in')
      session.email = session.email || session._email
      const result = await loginAndGetNumbers(session, count, chatId)
      session.token = result.token
      session.numbers = result.numbers
      pollPage = result.page
      sessions[chatId] = session
      log(chatId, `Logged in, numbers: ${result.numbers.length}`)
    }

    await stopPolling(chatId)

    const numList = session.numbers.map(n => `+48 ${n.number}`).join('\n')
    await ctx.telegram.editMessageText(chatId, msg.message_id, undefined,
      `Your numbers (${session.numbers.length}):\n${numList}\n\nMonitoring for incoming SMS...`
    )

    await startPolling(chatId, session, pollPage)
  } catch (e) {
    log(chatId, `Error: ${e.message}`)
    await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, `Error: ${e.message}`)
  } finally {
    delete processing[chatId]
  }
}

if (!isTest) {
const bot = new Telegraf(TG_TOKEN)

bot.use((ctx, next) => {
  const chatId = ctx.chat?.id
  if (chatId && !AUTHORIZED_USERS.has(chatId)) {
    log(chatId, 'Unauthorized access attempt')
    return ctx.reply('You are not authorized to use this bot.')
  }
  return next()
})

bot.start((ctx) => {
  const chatId = ctx.chat.id
  log(chatId, 'Bot started by user')
  const def = getUserDefaultNumbers(chatId)
  return ctx.reply(
    `How many numbers do you need? (Default: ${def})`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('1', 'set_count_1'),
        Markup.button.callback('2', 'set_count_2'),
        Markup.button.callback('3', 'set_count_3'),
      ],
      [Markup.button.callback(`Get ${def} Numbers`, 'get_number')]
    ])
  )
})

// Number count selection handlers
for (let n = 1; n <= 3; n++) {
  bot.action(`set_count_${n}`, async (ctx) => {
    const chatId = ctx.chat.id
    setUserDefaultNumbers(chatId, n)
    await ctx.answerCbQuery(`Default set to ${n}`)
    await ctx.editMessageText(
      `Default set to ${n} numbers. Tap below to get numbers.`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`Get ${n} Numbers`, 'get_number')]
      ])
    )
  })
}

bot.action('get_number', async (ctx) => {
  const chatId = ctx.chat.id
  const count = getUserDefaultNumbers(chatId)
  await processGetNumber(ctx, count)
})

bot.launch()
console.log(`${now()} [BOT] Bot started`)

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
  log(chatId, 'Running in test mode')

  let session, pollPage
  const count = testCount

  if (testLogin) {
    if (!testEmail) throw new Error('--login requires --email')
    const found = Object.values(sessions).find(s => s.email === testEmail)
    if (!found) throw new Error(`No saved session for ${testEmail}`)
    log(chatId, `Using existing session for ${testEmail}`)
    const result = await loginAndGetNumbers({ ...found, chatId }, count, chatId)
    session = { ...found, ...result, chatId }
    pollPage = result.page
  } else {
    const email = testEmail || `${rand(8)}@kilolabs.space`
    log(chatId, `Email: ${email}`)
    const result = await registerAndGetNumbers(count, chatId)
    session = { email, password: DEFAULT_PASSWORD, token: result.token, numbers: result.numbers, chatId }
    pollPage = result.page
    sessions[chatId] = session
  }

  const numList = session.numbers.map(n => `+48 ${n.number}`).join(', ')
  log(chatId, `Numbers (${session.numbers.length}): ${numList}`)
  log(chatId, `Polling for SMS for ${testTimeout / 1000}s, press Ctrl+C to stop`)

  await startPolling(chatId, session, pollPage)

  await sleep(testTimeout)
  await stopPolling(chatId)
  log(chatId, 'Test timeout reached')
  process.exit(0)
})().catch((e) => {
  console.error(`${now()} [TEST] Fatal error: ${e.message}`)
  process.exit(1)
})
}
