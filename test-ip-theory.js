// اختبار مؤقت: هل الـIP اللي يلتقط الرابط يقدر يجيبه برضو بطلب خارجي عادي
// بعد الالتقاط مباشرة؟ لو نجح، يثبت إن المشكلة IP الخدمة (Browserless)
// مو "نفس الجلسة" أو حماية عامة.
require('dotenv').config()
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  const m3u8Urls = new Set()
  page.on('response', (r) => {
    const u = r.url()
    if (u.includes('.m3u8') && !u.includes('.ts') && !u.includes('index-v1-a1.m3u8')) m3u8Urls.add(u)
  })
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36')

  await page.goto('https://web4.topcinema.fan/?s=American%20Wages', { waitUntil: 'domcontentloaded', timeout: 20000 })
  const resultUrl = await page.evaluate(() => {
    for (const a of document.querySelectorAll('a')) {
      const t = (a.textContent || '').toLowerCase()
      if (t.includes('american wages') && !a.href.includes('/series/') && !a.href.includes('/category/')) return a.href
    }
    return null
  })
  console.log('resultUrl:', resultUrl)
  if (!resultUrl) { await browser.close(); return }

  await page.goto(resultUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
  const watchUrl = await page.evaluate(() => document.querySelector('a.watch, a[href*="/watch/"]')?.href || null)
  await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })

  const buttons = await page.$$('li.server--item')
  for (let i = 2; i < Math.min(buttons.length, 5) && m3u8Urls.size === 0; i++) {
    const fresh = await page.$$('li.server--item')
    await fresh[i].click().catch(() => {})
    await new Promise((r) => setTimeout(r, 3000))
  }

  console.log('CAPTURED:', [...m3u8Urls])
  await browser.close()

  if (m3u8Urls.size === 0) {
    console.log('NO_CAPTURE')
    return
  }

  const url = [...m3u8Urls][0]
  console.log('\nنفس هذا الـIP (GitHub Actions runner) يجرب يجيب نفس الرابط بطلب خارجي عادي:')
  try {
    const res = await fetch(url, {
      headers: {
        Referer: watchUrl,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })
    console.log('RESULT_STATUS:', res.status)
  } catch (e) {
    console.log('RESULT_ERROR:', e.message)
  }
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
