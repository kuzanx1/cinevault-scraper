// scraper/lib/resolver.js
//
// المسؤول الوحيد عن: (1) إيجاد أي سيرفر منتهي/ميت بقاعدة البيانات
// و(2) إعادة البحث عنه باكوام (ak.sv) وتحديث الرابط. يشتغل بنفس المنطق
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
} = require('../config')

puppeteer.use(StealthPlugin())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
)

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
  const published = servers.filter((s) => s.title_id && s.titles?.is_published)

  // m3u8: نحسب الانتهاء من شكل الرابط (رخيص، بدون طلب شبكة). ملفات
  // مباشرة (mp4 اكوام) ما فيها توكن نقدر نحسبه، فنسويها فحص حي فعلي —
  // أبطأ، بس هذا المصدر الأساسي الحين بعد ما شلنا topcinema
  const m3u8Candidates = published.filter((s) => s.server_url?.includes('.m3u8'))
  const directCandidates = published.filter((s) => !s.server_url?.includes('.m3u8'))

  const expiredM3u8 = m3u8Candidates.filter((s) => isTokenExpired(s.server_url))

  const CONCURRENCY = 15
  const expiredDirect = []
  for (let i = 0; i < directCandidates.length; i += CONCURRENCY) {
    const batch = directCandidates.slice(i, i + CONCURRENCY)
    const aliveFlags = await Promise.all(batch.map((s) => isServerAlive(s.server_url)))
    batch.forEach((s, idx) => { if (!aliveFlags[idx]) expiredDirect.push(s) })
  }

  const expired = [...expiredM3u8, ...expiredDirect]
  log.info(`${servers.length} سيرفر اجمالي (${movieRows.length} فيلم + ${episodeRows.length} حلقة) — ${expired.length} منتهي`)
  return expired
}

// ─── (2) البحث في اكوام (ak.sv) عن رابط ───
// شلنا topcinema بالكامل — كل مزوديه (cdn-video.xyz, streamwish,
// videotube..) طلعوا محجوبين فعليًا من بنيتنا، أثبتناها بفك تشفير
// وتجربة مباشرة. اكوام مختلف جذريًا: عندهم مشغّل فيديو خاص فيهم،
// والفيديو رابط مباشر (mp4) من CDN مستقل (downet.net) غير محجوب.
// أفلام بس حاليًا — بنية حلقات المسلسلات عندهم ما دعمناها بعد.
const AKWAM_MEDIA_HOSTS = ['downet.net']

async function searchAkwam(browser, title, year, seasonNum, episodeNum) {
  const startedAt = Date.now()

  if (seasonNum && episodeNum) {
    return {
      status: 'unsupported', reason: 'اكوام يدعم الأفلام بس حاليًا',
      matchedUrl: null, watchUrl: null, hlsUrls: [], elapsedMs: Date.now() - startedAt,
    }
  }

  // اكوام: دمج السنة بنص البحث يكسر النتائج (جربناها فعليًا، ترجع صفر
  // نتائج) — نبحث بالعنوان الخام بس، ونستخدم السنة كمرشّح تحقق بعدين
  const searchUrl = `https://ak.sv/search?q=${encodeURIComponent(title)}`

  log.info(`[akwam] يبحث عن: "${title}"`)

  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  const mediaMap = new Map()

  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const t = req.resourceType()
    // مهم: ما نحجب 'media' هنا — هذا نوع الطلب اللي فيه رابط الفيديو
    // المباشر اللي نبيه نلتقطه (اكوام يشغّله بمشغّل native، مو iframe)
    if (isBlocked(req.url()) || t === 'font' || t === 'stylesheet' || t === 'image') {
      return req.abort()
    }
    req.continue()
  })

  page.on('response', (response) => {
    try {
      const url = response.url()
      const status = response.status()
      if (
        AKWAM_MEDIA_HOSTS.some((h) => url.includes(h)) &&
        /\.(mp4|mkv|webm)(\?|$)/i.test(url) &&
        status >= 200 && status < 400
      ) {
        const key = url.split('?')[0]
        if (!mediaMap.has(key)) mediaMap.set(key, url)
      }
    } catch {}
  })

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36'
  )

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
    await wait(1000)

    // اكوام يرجّع لستة نتائج بعناوين متشابهة (Godfather, Godfather
    // Part II, Godfather of Northeast China...) — تطابق كلمات فضفاض
    // زي topcinema يلقط أول واحد غلط. نطابق النص بالكامل (بعد تطبيع)
    // + نتحقق من السنة المعروضة جنب كل نتيجة كمرشّح إضافي
    const resultUrl = await page.evaluate((t, y) => {
      const norm = (s) => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
      const targetNorm = norm(t)
      const candidates = []
      for (const a of document.querySelectorAll('a[href*="/movie/"]')) {
        const text = norm(a.innerText || a.title || '')
        if (!text) continue
        let yearText = ''
        let parent = a.closest('.entry-box, .col-lg-2, .grid-item, li') || a.parentElement
        for (let i = 0; i < 4 && parent; i++) {
          const m = parent.textContent.match(/\b(19|20)\d{2}\b/)
          if (m) { yearText = m[0]; break }
          parent = parent.parentElement
        }
        candidates.push({ href: a.href, text, yearText })
      }
      for (const c of candidates) if (c.text === targetNorm && (!y || c.yearText === String(y))) return c.href
      for (const c of candidates) if (c.text === targetNorm) return c.href
      for (const c of candidates) if (c.text.startsWith(targetNorm) && (!y || c.yearText === String(y))) return c.href
      return null
    }, title, year)

    if (!resultUrl) {
      await context.close()
      return {
        status: 'source_not_found', reason: 'لم يتم العثور على نتيجة مطابقة باكوام',
        matchedUrl: null, watchUrl: null, hlsUrls: [], elapsedMs: Date.now() - startedAt,
      }
    }

    await page.goto(resultUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
    await wait(500)

    const watchUrl = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(
        (el) => el.textContent.includes('مشاهدة') && !el.href.includes('#')
      )
      return a?.href || null
    })

    if (!watchUrl) {
      await context.close()
      return {
        status: 'page_loaded_no_hls', reason: 'ما لقينا رابط مشاهدة بصفحة الفيلم',
        matchedUrl: resultUrl, watchUrl: null, hlsUrls: [], elapsedMs: Date.now() - startedAt,
      }
    }

    await page.goto(watchUrl, { waitUntil: 'networkidle2', timeout: CONFIG.pageTimeout })
    await wait(1500)
    await context.close()

    const urls = [...mediaMap.values()]
    if (!urls.length) {
      return {
        status: 'page_loaded_no_hls', reason: 'تم فتح صفحة المشاهدة بس ما ظهر رابط فيديو',
        matchedUrl: watchUrl, watchUrl, hlsUrls: [], elapsedMs: Date.now() - startedAt,
      }
    }

    return {
      status: 'success', reason: null,
      matchedUrl: watchUrl, watchUrl, hlsUrls: urls.slice(0, 3), elapsedMs: Date.now() - startedAt,
    }
  } catch (e) {
    try { await context.close() } catch {}
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

  // اكوام ما يتحقق من referer أصلًا (جربناها) — بس نسجّله للتوثيق
  const refererUrl = 'https://ak.sv/'

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

  const result = await searchAkwam(browser, title.original_title, title.year, seasonNum, episodeNum)
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
