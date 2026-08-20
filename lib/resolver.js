// scraper/lib/resolver.js
//
// المسؤول الوحيد عن: (1) إيجاد أي سيرفر m3u8 منتهي الصلاحية بقاعدة البيانات
// و(2) إعادة البحث عنه بـ topcinema وتحديث الرابط. يشتغل بنفس المنطق
// للأفلام والمسلسلات لأنه يعتمد على جدول servers مباشرة (title_id/episode_id)
// مو على نوع المحتوى.
require('dotenv').config()

const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const { createClient } = require('@supabase/supabase-js')

const {
  CONFIG,
  log,
  wait,
  isTokenExpired,
  isServerAlive,
  isBlocked,
  isEmbedDomain,
  cleanTitleForSearch,
} = require('../config')

puppeteer.use(StealthPlugin())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
)

// ─── ترتيب جودة روابط m3u8 (master أفضل من index الفرعي) ───
function scoreM3u8Url(url = '') {
  let score = 0
  if (url.includes('.urlset/master.m3u8')) score += 1400
  if (url.includes('master.m3u8')) score += 1200
  if (url.includes('playlist.m3u8')) score += 800
  if (url.includes('chunklist')) score += 500
  if (url.includes('index.m3u8')) score += 250
  if (url.includes('index-v1-a1.m3u8')) score -= 200

  const res = url.match(/(\d{3,4})p/i)
  if (res) score += parseInt(res[1], 10)

  return score
}

function pickBestM3u8(results) {
  const unique = new Map()
  for (const item of results) {
    if (!item?.url || !item.url.includes('.m3u8')) continue
    const key = item.url.split('?')[0]
    if (!unique.has(key)) unique.set(key, item)
  }
  return [...unique.values()].sort((a, b) => scoreM3u8Url(b.url) - scoreM3u8Url(a.url))
}

async function fetchAllPages(buildQuery) {
  // Supabase يرجع 1000 صف كحد أقصى بالطلب الواحد — لازم صفحات عشان
  // نغطي كل الجدول (عندنا عشرات الآلاف من السيرفرات)
  const PAGE_SIZE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1)
    if (error) {
      log.error(`فشل جلب السيرفرات: ${error.message}`)
      break
    }
    if (!data?.length) break
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
  }
  return rows
}

// ─── (1) روابط منتهية بقاعدة البيانات ───
// سيرفرات الأفلام: title_id مباشر على servers.
// سيرفرات الحلقات: title_id فاضي على servers نفسها، لازم نوصله عن طريق
// episode_id → episodes → seasons → title_id. لو ما سوينا هالربط، الفحص
// الدوري يتجاهل كل حلقات المسلسلات بصمت (كان هذا خلل موجود بالنسخة الأصلية).
async function getExpiredServers() {
  const movieRows = await fetchAllPages(() =>
    supabase
      .from('servers')
      .select(`
        id, title_id, episode_id, server_url,
        titles!inner ( id, original_title, year, type, is_published )
      `)
      .eq('is_embed', false)
      .eq('is_active', true)
      .not('server_url', 'is', null)
      .not('title_id', 'is', null)
  )

  const episodeRows = await fetchAllPages(() =>
    supabase
      .from('servers')
      .select(`
        id, episode_id, server_url,
        episodes!inner (
          id, is_published,
          seasons!inner ( season_number, titles!inner ( id, original_title, year, type, is_published ) )
        )
      `)
      .eq('is_embed', false)
      .eq('is_active', true)
      .not('server_url', 'is', null)
      .not('episode_id', 'is', null)
  ).then((rows) =>
    rows.map((r) => ({
      id: r.id,
      title_id: r.episodes?.seasons?.titles?.id || null,
      episode_id: r.episode_id,
      server_url: r.server_url,
      titles: {
        ...r.episodes?.seasons?.titles,
        is_published: Boolean(r.episodes?.is_published && r.episodes?.seasons?.titles?.is_published),
      },
    }))
  )

  const servers = [...movieRows, ...episodeRows]
  const expired = servers.filter((s) => s.title_id && s.titles?.is_published && isTokenExpired(s.server_url))
  log.info(`${servers.length} سيرفر اجمالي (${movieRows.length} فيلم + ${episodeRows.length} حلقة) — ${expired.length} منتهي`)
  return expired
}

// ─── (2) البحث في topcinema عن رابط بديل ───
function setupM3u8Interceptor(page, m3u8Map, meta = {}) {
  page.on('response', async (response) => {
    try {
      const url = response.url()
      const status = response.status()
      if (
        url.includes('.m3u8') &&
        !url.includes('index-v1-a1.m3u8') &&
        !url.includes('.ts') &&
        status >= 200 && status < 400 &&
        !isBlocked(url)
      ) {
        const key = url.split('?')[0]
        if (!m3u8Map.has(key)) {
          m3u8Map.set(key, { url, watchPageUrl: meta.watchPageUrl || null })
        }
      }
    } catch {}
  })
}

async function extractEmbeds(page, embedMap) {
  try {
    const srcs = await page.evaluate(() =>
      [...document.querySelectorAll('iframe')]
        .map((f) => f.src || f.getAttribute('data-src') || '')
        .filter(Boolean)
    )
    for (const src of srcs) {
      if (isEmbedDomain(src) && !isBlocked(src)) embedMap.set(src, { url: src })
    }
  } catch {}
}

async function clickAllServers(page, embedMap, m3u8Map, { earlyExit = false, refererUrl } = {}) {
  const buttons = await page.$$('li.server--item')
  if (!buttons.length) return 0

  log.info(`${buttons.length} سيرفر`)

  for (let i = 0; i < buttons.length; i++) {
    try {
      const freshButtons = await page.$$('li.server--item')
      const btn = freshButtons[i]
      if (!btn) continue

      const beforeCount = m3u8Map.size
      await btn.click()
      await wait(CONFIG.waitAfterClick)
      await extractEmbeds(page, embedMap)
      await wait(CONFIG.waitAfterAll)

      if (m3u8Map.size === beforeCount) await wait(1500)

      // وضع سريع: أول ما ينلقط رابط نوقف — الالتقاط نفسه (رد 200-399
      // بمتصفح حقيقي) هو التحقق. تحقق إضافي بطلب منفصل بعد الالتقاط
      // جربناه ووجدناه يفشل بالغلط لبعض الـCDN (قيود CORS/جلسة) حتى لو
      // الرابط شغال فعلاً — فما نعتمد عليه هنا.
      if (earlyExit && m3u8Map.size > beforeCount) {
        log.success(`لقينا رابط بعد ${i + 1} محاولة — نوقف هنا`)
        return buttons.length
      }
    } catch {}
  }

  return buttons.length
}

async function searchTopCinema(browser, title, year, seasonNum, episodeNum) {
  const startedAt = Date.now()
  const query = cleanTitleForSearch(title, year)
  const searchUrl = CONFIG.source.searchUrl.replace('{query}', encodeURIComponent(query))

  log.info(`[topcinema] يبحث عن: "${title}"`)

  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  const m3u8Map = new Map()
  const embedMap = new Map()

  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const t = req.resourceType()
    if (isBlocked(req.url()) || t === 'font' || t === 'stylesheet' || t === 'image' || t === 'media') {
      return req.abort()
    }
    req.continue()
  })

  await page.evaluateOnNewDocument(() => { window.open = () => null })
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36'
  )

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
    await wait(1000)

    const resultUrl = await page.evaluate((t, isEpisode) => {
      const tLower = t.toLowerCase()
      const tWords = tLower.split(' ').filter((w) => w.length > 2)

      for (const a of document.querySelectorAll('a')) {
        const text = (a.innerText || a.title || '').toLowerCase()
        const href = a.href || ''
        const matched = tWords.length
          ? tWords.filter((w) => text.includes(w)).length / tWords.length
          : 0

        if (matched >= 0.5) {
          if (isEpisode && href.includes('/series/')) return href
          if (!isEpisode && !href.includes('/series/') && !href.includes('/category/')) return href
        }
      }
      return null
    }, title, Boolean(seasonNum))

    if (!resultUrl) {
      await context.close()
      return {
        status: 'source_not_found',
        reason: 'لم يتم العثور على نتيجة مطابقة في صفحة البحث',
        matchedUrl: null, watchUrl: null, hlsUrls: [], elapsedMs: Date.now() - startedAt,
      }
    }

    let targetUrl = resultUrl

    if (seasonNum && episodeNum) {
      await page.goto(resultUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
      await wait(800)

      const episodeUrl = await page.evaluate((sNum, eNum) => {
        for (const a of document.querySelectorAll('a')) {
          const text = (a.innerText || '').toLowerCase()
          const href = a.href || ''
          const hasEp = text.includes(`الحلقة ${eNum}`) || text.includes(`episode ${eNum}`) ||
            text.includes(`e${String(eNum).padStart(2, '0')}`)
          const hasSn = text.includes(`الموسم ${sNum}`) || text.includes(`season ${sNum}`) || sNum === 1
          if (hasEp && hasSn) return href
        }
        return null
      }, seasonNum, episodeNum)

      if (!episodeUrl) {
        await context.close()
        return {
          status: 'source_not_found',
          reason: `لم يتم العثور على الحلقة S${seasonNum}E${episodeNum}`,
          matchedUrl: resultUrl, watchUrl: null, hlsUrls: [], elapsedMs: Date.now() - startedAt,
        }
      }
      targetUrl = episodeUrl
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
    await wait(800)

    const watchUrl = await page.evaluate(() =>
      document.querySelector('a.watch, a[href*="/watch/"]')?.href || null
    )

    if (watchUrl) {
      await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
      await wait(800)
    }

    setupM3u8Interceptor(page, m3u8Map, { watchPageUrl: watchUrl || targetUrl })
    await extractEmbeds(page, embedMap)
    await clickAllServers(page, embedMap, m3u8Map, {
      earlyExit: true,
      refererUrl: watchUrl || targetUrl,
    })
    await wait(CONFIG.waitAfterAll)

    const candidates = pickBestM3u8([...m3u8Map.values()])
    await context.close()

    if (!candidates.length) {
      return {
        status: 'page_loaded_no_hls',
        reason: 'تم فتح الصفحة ولكن لم يظهر أي رابط HLS',
        matchedUrl: targetUrl, watchUrl: watchUrl || null, hlsUrls: [], elapsedMs: Date.now() - startedAt,
      }
    }

    // ملاحظة مهمة: كنا نسوي تحقق إضافي هنا (طلب HTTP منفصل بعد الالتقاط)
    // قبل ما نثق بالرابط. تبين إنه يفشل بالغلط — جربناه على رابط شغال
    // ١٠٠٪ فعليًا (تأكدنا يدويًا) ورجع 403 حتى من نفس المتصفح/الـIP اللي
    // التقطه، بسبب قيود CORS/جلسة على بعض الـCDN (streamwish, earnvids).
    // الالتقاط نفسه (رد 200-399 من طلب حقيقي بالمتصفح أثناء التصفح) هو
    // التحقق الموثوق — نكتب كل المرشحين مباشرة.
    return {
      status: 'success',
      reason: null,
      matchedUrl: targetUrl,
      watchUrl: watchUrl || null,
      hlsUrls: candidates.slice(0, 5).map((r) => r.url),
      elapsedMs: Date.now() - startedAt,
    }
  } catch (e) {
    await context.close()
    return {
      status: 'unexpected_error', reason: e.message,
      matchedUrl: null, watchUrl: null, hlsUrls: [], elapsedMs: Date.now() - startedAt,
    }
  }
}

// ─── تحديث/إضافة السيرفرات بقاعدة البيانات ───
async function updateServersInSupabase(titleId, episodeId, hlsUrls, watchPageUrl) {
  if (!hlsUrls.length) return { ok: false, reason: 'no_hls_urls' }

  let q = supabase.from('servers').select('id').eq('title_id', titleId).eq('is_embed', false)
  q = episodeId ? q.eq('episode_id', episodeId) : q.is('episode_id', null)

  const { data: existing, error } = await q
  if (error) return { ok: false, reason: error.message }

  // نفس مرجع hls-proxy الحالي — topcinema فقط
  const refererUrl = 'https://web5.topcinema.fan/'

  for (let i = 0; i < hlsUrls.length; i++) {
    const newUrl = hlsUrls[i]
    const payload = {
      server_url: newUrl,
      watch_page_url: watchPageUrl || null,
      referer_url: refererUrl,
      updated_at: new Date().toISOString(),
    }

    if (existing && existing[i]) {
      const { error: updateError } = await supabase.from('servers').update(payload).eq('id', existing[i].id)
      if (updateError) return { ok: false, reason: updateError.message }
    } else {
      const { error: insertError } = await supabase.from('servers').insert({
        title_id: titleId,
        episode_id: episodeId || null,
        server_name: `HLS ${i + 1}`,
        quality: 'best',
        language: 'ar',
        is_embed: false,
        is_active: true,
        sort_order: i,
        ...payload,
      })
      if (insertError) return { ok: false, reason: insertError.message }
    }
  }

  return { ok: true }
}

async function getTitleAndEpisode(titleId, episodeId = null) {
  const { data: title } = await supabase
    .from('titles').select('id, original_title, year, type').eq('id', titleId).single()
  if (!title) return null

  let seasonNum = null
  let episodeNum = null

  if (episodeId) {
    const { data: ep } = await supabase
      .from('episodes').select('episode_number, seasons(season_number)').eq('id', episodeId).single()
    if (ep) {
      episodeNum = ep.episode_number
      seasonNum = ep.seasons?.season_number
    }
  }

  return { title, seasonNum, episodeNum }
}

async function refreshTitle(browser, titleId, episodeId = null, reporter = null) {
  const meta = await getTitleAndEpisode(titleId, episodeId)
  if (!meta) return { status: 'failed', reason: 'title_not_found' }

  const { title, seasonNum, episodeNum } = meta
  log.title(`${title.original_title} (${title.year})${episodeId ? ` S${seasonNum}E${episodeNum}` : ''}`)

  let serverQ = supabase.from('servers').select('id, server_url')
    .eq('title_id', titleId).eq('is_active', true).eq('is_embed', false)
  serverQ = episodeId ? serverQ.eq('episode_id', episodeId) : serverQ.is('episode_id', null)

  const { data: existing } = await serverQ

  // فحص حقيقي (مو رقمي بس) — يكفي وجود سيرفر واحد شغال فعليًا عشان نتخطى
  // إعادة السحب (يوفر وقت/تكلفة، وأدق من الاعتماد على حساب الأرقام لحاله)
  if (existing?.length > 0) {
    const aliveChecks = await Promise.all(existing.map((s) => isServerAlive(s.server_url)))
    if (aliveChecks.some(Boolean)) {
      reporter?.pushJob({
        titleId, episodeId, title: title.original_title, year: title.year,
        status: 'skipped', reason: 'at_least_one_existing_hls_alive', hlsCount: existing.length,
      })
      log.success('شغال — لا تحديث')
      return { status: 'skipped' }
    }
  }

  const result = await searchTopCinema(browser, title.original_title, title.year, seasonNum, episodeNum)
  reporter?.appendAttempt({
    titleId, episodeId, title: title.original_title, year: title.year,
    status: result.status, reason: result.reason, matchedUrl: result.matchedUrl,
    hlsCount: result.hlsUrls.length, elapsedMs: result.elapsedMs,
  })

  if (result.status !== 'success') {
    reporter?.pushJob({
      titleId, episodeId, title: title.original_title, year: title.year,
      status: 'failed', reason: result.reason || result.status, hlsCount: 0,
    })
    log.warn(`ما لقينا HLS: ${title.original_title}`)
    return { status: 'failed', reason: result.reason }
  }

  const dbResult = await updateServersInSupabase(titleId, episodeId, result.hlsUrls, result.watchUrl)

  if (!dbResult.ok) {
    reporter?.pushJob({
      titleId, episodeId, title: title.original_title, year: title.year,
      status: 'failed', reason: `db_update_failed: ${dbResult.reason}`, hlsCount: result.hlsUrls.length,
    })
    return { status: 'failed', reason: dbResult.reason }
  }

  reporter?.pushJob({
    titleId, episodeId, title: title.original_title, year: title.year,
    status: 'success', reason: null, hlsCount: result.hlsUrls.length,
  })

  return { status: 'success', hlsCount: result.hlsUrls.length }
}

async function launchMainBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  })
}

module.exports = {
  supabase,
  getExpiredServers,
  refreshTitle,
  launchMainBrowser,
}
