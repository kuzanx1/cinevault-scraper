// scraper/config.js
const path = require('path')

const CONFIG = {
  // topcinema فقط — faselhd أُزيل نهائيًا بطلب من المالك
  source: {
    name: 'topcinema',
    searchUrl: 'https://web4.topcinema.fan/?s={query}',
  },

  embedDomains: [
    'streamwish', 'filelions', 'doodstream', 'streamtape',
    'uqload', 'mixdrop', 'vidhide', 'filemoon', 'upstream',
    'lulustream', 'earnvids', 'updown', 'vidcloud',
    // ok.ru (Odnoklassniki) — منصة فيديو ضخمة وشرعية، embed API رسمي
    // عندها. تحققنا فعليًا: يرجع 200 لأي referer (حتى موقعنا)، عكس
    // vidtube.one اللي يرفض صراحة أي دومين غير topcinema.fan
    'ok.ru',
  ],
  // ملاحظة: جربنا نضيف vidtube (VideoTube) هنا لكن رجّعناها — تحقق
  // مباشر (fetch بـReferer=موقعنا) رجع "Video embed restricted for
  // this domain": vidtube.one يتحقق من دومين الإحالة صراحة وما يقبل
  // إلا topcinema.fan. يعني نقدر نلتقط رابطه لكن ما يشتغل أبدًا لما
  // نعرضه بموقعنا — تسجيله كembed يعطي "نجاح" وهمي يوقف الزائر بدل
  // ما يجربه سيرفر حقيقي. لو حبينا نستخدمه لازم نبني بروكسي HTML كامل
  // (زي hls-proxy) يجيبه من سيرفرنا بReferer=topcinema.fan ويعيد
  // تقديمه — مجهود أكبر بكثير، ما سويناه لين الحين

  blockedDomains: [
    'googlesyndication', 'doubleclick', 'googletagmanager',
    'google-analytics', 'facebook.com/tr', 'hotjar',
    'clarity.ms', 'adnxs', 'taboola', 'outbrain',
  ],

  pageTimeout: 20000,
  waitAfterClick: 3000,
  waitAfterAll: 2000,
  // قبل ما ينتهي التوكن الفعلي بهالمدة، نعتبره "منتهي" ونجدده مسبقًا
  // بدل ما ننتظر يموت فعليًا والزائر يشوفه ميت
  tokenExpiryBuffer: 2 * 60 * 60,
  // كم عنوان نعالج بالتوازي بنفس الوقت — كل واحد يفتح browser context
  // مستقل، فلا نرفعها كثير على أجهزة/CI بموارد محدودة
  batchSize: 10,

  paths: {
    puppeteerProfile: path.join(__dirname, 'puppeteer-profile'),
    reportsDir: path.join(__dirname, 'reports'),
  },
}

const log = {
  info: (msg) => console.log(`\x1b[36mi  ${msg}\x1b[0m`),
  success: (msg) => console.log(`\x1b[32m✅ ${msg}\x1b[0m`),
  warn: (msg) => console.log(`\x1b[33m⚠  ${msg}\x1b[0m`),
  error: (msg) => console.log(`\x1b[31m❌ ${msg}\x1b[0m`),
  title: (msg) => console.log(`\x1b[35m🎬 ${msg}\x1b[0m`),
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// روابط m3u8 عندنا فيها توكن بصيغة ?...&s=<unix_start>&e=<seconds_valid_for>
// يعني وقت الانتهاء الفعلي = s + e، مو e لحالها (e رقم صغير زي 43200 = مدة
// بالثواني مو timestamp مطلق). هالفحص تقريبي/سريع بس — الفحص الحقيقي
// الموثوق هو isServerAlive (طلب HTTP فعلي)، هذا يستخدم كمرشّح أولي بس
// عشان ما نسوي HTTP check على كل رابط كل مرة.
function isTokenExpired(url) {
  if (!url || !url.includes('.m3u8')) return true

  const eMatch = url.match(/[?&]e=(\d+)/)
  if (!eMatch) return false // ما فيه معلومة مدة — خله يعتمد على isServerAlive

  const durationOrExpiry = parseInt(eMatch[1], 10)
  const sMatch = url.match(/[?&]s=(\d+)/)
  const nowSec = Math.floor(Date.now() / 1000)

  // لو فيه s=، القيمتين مع بعض = وقت الانتهاء الفعلي
  if (sMatch) {
    const start = parseInt(sMatch[1], 10)
    return start + durationOrExpiry - nowSec < CONFIG.tokenExpiryBuffer
  }

  // ما فيه s= — لو e= رقم كبير (يشبه unix timestamp فعلي) عاملها كذا،
  // غير كذا اعتبرها مدة من "الآن" (تقريب متحفظ)
  const looksLikeAbsoluteTimestamp = durationOrExpiry > 1_000_000_000
  if (looksLikeAbsoluteTimestamp) {
    return durationOrExpiry - nowSec < CONFIG.tokenExpiryBuffer
  }
  return false
}

// فحص حقيقي: نطلب الرابط فعليًا ونشوف يرد؟ هذا هو المرجع الموثوق،
// مو حساب الأرقام بالرابط (بعض الروابط تموت خلال ثواني من انسحابها
// لأسباب غير مرتبطة بالمدة المكتوبة — احتمال ربط بجلسة/IP السحب).
async function isServerAlive(url, refererUrl, timeoutMs = 8000) {
  if (!url || !url.includes('.m3u8')) return false
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Referer: refererUrl || 'https://web5.topcinema.fan/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

function isBlocked(url) {
  return CONFIG.blockedDomains.some((d) => url.includes(d))
}

function isEmbedDomain(url) {
  return CONFIG.embedDomains.some((d) => url.includes(d))
}

function cleanTitleForSearch(title, year) {
  if (!title) return ''
  let clean = title.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (year) clean = `${clean} ${year}`
  return clean
}

function sortByYear(items) {
  return [...items].sort((a, b) => {
    const ya = parseInt(a.title?.year) || 0
    const yb = parseInt(b.title?.year) || 0
    return yb - ya
  })
}

function groupExpiredByTitle(expiredServers) {
  const map = new Map()
  for (const s of expiredServers) {
    const key = `${s.title_id}::${s.episode_id || 'null'}`
    if (!map.has(key)) {
      map.set(key, {
        title_id: s.title_id,
        episode_id: s.episode_id,
        title: s.titles,
        servers: [],
      })
    }
    map.get(key).servers.push(s)
  }
  return [...map.values()]
}

module.exports = {
  CONFIG,
  log,
  wait,
  isTokenExpired,
  isServerAlive,
  isBlocked,
  isEmbedDomain,
  cleanTitleForSearch,
  sortByYear,
  groupExpiredByTitle,
}
