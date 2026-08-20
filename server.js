// scraper/server.js
// سيرفر واحد لكل شي: تحديث فوري عند الطلب (POST /refresh) + فحص دوري
// تلقائي كل ساعة لكل الروابط المنتهية (أفلام ومسلسلات معًا).
// هذا يحل محل server.js + scraper.js + movies-server.js + movies-scraper.js
// + srsserver.js القديمين بالمشروع الأصلي — كانوا 3 نسخ متكررة من نفس الفكرة.
require('dotenv').config()
const express = require('express')
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const { log } = require('./config')
const { refreshTitle } = require('./lib/resolver')
const { runScheduledCheck } = require('./run-scheduled-check')

puppeteer.use(StealthPlugin())

const app = express()
const PORT = process.env.PORT || 3001

app.use(express.json())

let browser = null
let isRunningScheduledCheck = false
let lastRunStartedAt = null
let lastRunFinishedAt = null
let lastRunStatus = 'never'
let lastRunError = null
let nextScheduledRunAt = null
let shutdownRequested = false

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    })
  }
  return browser
}

async function closeBrowserSafe() {
  try {
    if (browser && browser.connected) await browser.close()
  } catch (e) {
    log.error(`closeBrowserSafe error: ${e.message}`)
  } finally {
    browser = null
  }
}

async function runScheduledCheckSafely(trigger = 'manual') {
  if (isRunningScheduledCheck) return { started: false, reason: 'already-running' }

  isRunningScheduledCheck = true
  lastRunStartedAt = new Date().toISOString()
  lastRunStatus = 'running'
  lastRunError = null

  log.info(`🚀 بدء runScheduledCheck [${trigger}] at ${lastRunStartedAt}`)

  try {
    await runScheduledCheck()
    lastRunStatus = 'success'
    return { started: true, success: true }
  } catch (err) {
    lastRunStatus = 'failed'
    lastRunError = err.message
    log.error(`runScheduledCheck (${trigger}) error: ${err.message}`)
    return { started: true, success: false, error: err.message }
  } finally {
    lastRunFinishedAt = new Date().toISOString()
    isRunningScheduledCheck = false
    log.success(`انتهى runScheduledCheck [${trigger}] at ${lastRunFinishedAt}`)
  }
}

// ─── POST /refresh — تحديث فوري لعنوان/حلقة معينة ───
app.post('/refresh', async (req, res) => {
  const { title_id, episode_id } = req.body

  if (!title_id) return res.status(400).json({ error: 'title_id مطلوب' })

  log.info(`طلب تحديث: ${title_id}${episode_id ? ` / ${episode_id}` : ''}`)

  try {
    const b = await getBrowser()
    const result = await refreshTitle(b, title_id, episode_id || null)
    return res.json({ ...result, title_id, episode_id: episode_id || null })
  } catch (e) {
    log.error(`خطأ /refresh: ${e.message}`)
    return res.status(500).json({ error: e.message })
  }
})

// ─── GET /health ───
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    browser: browser?.connected ? 'connected' : 'disconnected',
    source: 'topcinema',
    scheduler: isRunningScheduledCheck ? 'running' : 'idle',
    lastRunStartedAt,
    lastRunFinishedAt,
    lastRunStatus,
    lastRunError,
    nextScheduledRunAt,
    time: new Date().toISOString(),
  })
})

// ─── POST /run-check — تشغيل الفحص الدوري يدويًا ───
app.post('/run-check', async (req, res) => {
  if (isRunningScheduledCheck) {
    return res.status(409).json({ message: 'يوجد فحص شغال بالفعل', scheduler: 'running', lastRunStartedAt })
  }

  res.json({ message: 'بدأ الفحص في الخلفية', scheduler: 'started' })

  runScheduledCheckSafely('manual').catch((err) => {
    log.error(`runScheduledCheckSafely manual error: ${err.message}`)
  })
})

app.listen(PORT, () => {
  log.success(`Scraper Server شغال على port ${PORT}`)
  console.log('   POST /refresh    → تحديث عنوان/حلقة معينة فورًا')
  console.log('   GET  /health     → فحص الحالة')
  console.log('   POST /run-check  → فحص دوري يدوي لكل الروابط المنتهية')
})

// ─── فحص تلقائي كل ساعة ───
const CHECK_INTERVAL = 60 * 60 * 1000

async function scheduleNextRun(delay = CHECK_INTERVAL) {
  if (shutdownRequested) return
  nextScheduledRunAt = new Date(Date.now() + delay).toISOString()

  setTimeout(async () => {
    if (shutdownRequested) return
    log.info('⏰ Cron: بدء الفحص التلقائي...')
    try {
      await runScheduledCheckSafely('cron')
    } finally {
      await scheduleNextRun(CHECK_INTERVAL)
    }
  }, delay)
}

scheduleNextRun(2 * 60 * 1000)

async function gracefulShutdown(signal) {
  if (shutdownRequested) return
  shutdownRequested = true

  log.warn(`${signal}: إيقاف السيرفر...`)
  const startedAt = Date.now()

  while (isRunningScheduledCheck && Date.now() - startedAt < 60_000) {
    log.info('⏳ انتظار انتهاء الفحص الحالي قبل الإغلاق...')
    await new Promise((r) => setTimeout(r, 1000))
  }

  await closeBrowserSafe()
  process.exit(0)
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
