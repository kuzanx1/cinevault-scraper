// تجهيز جماعي للروابط.
//
// الفكرة: بدل ما ننتظر زائر يفتح فيلم ويكتشف إن رابطه ميت (وينتظر 30
// ثانية وهو قاعد)، نجهّز روابط الكتالوج كامل مسبقًا. النتيجة إن الزائر
// يلقى الرابط جاهز من أول لحظة.
//
// ليش هذا مجاني: الريبو عام (public)، ودقائق GitHub Actions للريبوهات
// العامة **غير محدودة**. نقسّم الشغل على عدة jobs متوازية عبر matrix،
// كل job ياخذ شريحة (shard) من العناوين. ما نخزّن أي فيديو — بس نص
// الرابط، فحجم التخزين يبقى تافه مهما كبر الكتالوج.
//
// متغيرات البيئة:
//   SHARD_INDEX / SHARD_COUNT — أي شريحة يشتغل عليها هذا الـjob
//   MAX_RUN_MINUTES           — سقف وقت اختياري
//   ONLY_MISSING              — '1' يعالج بس اللي ماله رابط شغّال أصلاً

require('dotenv').config()
const { log, CONFIG } = require('./config')
const { createRunReporter } = require('./lib/reporter')
const { supabase, refreshTitle, launchMainBrowser } = require('./lib/resolver')

const SHARD_INDEX = Number(process.env.SHARD_INDEX || 0)
const SHARD_COUNT = Number(process.env.SHARD_COUNT || 1)
const MAX_RUN_MINUTES = Number(process.env.MAX_RUN_MINUTES || 0)
const ONLY_MISSING = process.env.ONLY_MISSING === '1'

// Supabase يرجّع 1000 صف كحد أقصى للطلب — نصفّح عشان نجيب الكل
async function fetchAll(build) {
  const out = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data || !data.length) break
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

async function main() {
  log.info(`شريحة ${SHARD_INDEX + 1}/${SHARD_COUNT}`)

  const movies = await fetchAll(() =>
    supabase.from('titles').select('id, original_title, year').eq('type', 'movie')
  )

  // العناوين اللي عندها رابط شغّال أصلاً — نتخطاها لو ONLY_MISSING
  let skip = new Set()
  if (ONLY_MISSING) {
    const servers = await fetchAll(() =>
      supabase
        .from('servers')
        .select('title_id')
        .eq('is_active', true)
        .eq('is_embed', false)
        .is('episode_id', null)
    )
    skip = new Set(servers.map((s) => s.title_id))
    log.info(`${skip.size} عنوان عنده رابط أصلاً — نتخطاهم`)
  }

  // التقسيم على الشرائح ثابت (حسب الترتيب) عشان الـjobs ما تتداخل
  const mine = movies.filter(
    (t, i) => i % SHARD_COUNT === SHARD_INDEX && !skip.has(t.id)
  )

  log.info(`${mine.length} عنوان بهذي الشريحة`)
  if (!mine.length) return

  const reporter = createRunReporter()
  const deadline = MAX_RUN_MINUTES ? Date.now() + MAX_RUN_MINUTES * 60 * 1000 : Infinity
  const browser = await launchMainBrowser()

  let done = 0
  let ok = 0

  try {
    for (let i = 0; i < mine.length; i += CONFIG.batchSize) {
      if (Date.now() >= deadline) {
        log.warn(`وقفنا عند حد الوقت — ${done}/${mine.length}`)
        break
      }

      const batch = mine.slice(i, i + CONFIG.batchSize)
      const results = await Promise.all(
        batch.map((t) =>
          refreshTitle(browser, t.id, null, reporter)
            .then((r) => Boolean(r))
            .catch(() => false)
        )
      )

      done += batch.length
      ok += results.filter(Boolean).length
      log.info(`${done}/${mine.length} — نجح ${ok}`)
    }
  } finally {
    await browser.close().catch(() => {})
    reporter.finish()
  }

  log.success(`خلصت الشريحة: ${ok}/${done} نجحوا`)
}

main().catch((e) => {
  log.error(e.message)
  process.exit(1)
})
