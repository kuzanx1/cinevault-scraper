// اختبار: هل الحظر بس على master.m3u8 (بوابة الدخول) أو على كل مقطع؟
const MASTER_URL = process.env.MASTER_URL

async function main() {
  const res = await fetch(MASTER_URL, {
    headers: {
      Referer: 'https://web5.topcinema.fan/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  })
  console.log('MASTER_STATUS:', res.status)
  if (!res.ok) return

  const text = await res.text()
  console.log('MASTER_CONTENT:')
  console.log(text)

  const subLine = text.split('\n').find((l) => l.trim() && !l.startsWith('#'))
  if (!subLine) { console.log('NO_SUB_URL_FOUND'); return }

  const subUrl = new URL(subLine.trim(), MASTER_URL).toString()
  console.log('SUB_URL:', subUrl)

  const res2 = await fetch(subUrl, {
    headers: {
      Referer: 'https://web5.topcinema.fan/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  })
  console.log('SUB_STATUS:', res2.status)
  if (res2.ok) {
    const subText = await res2.text()
    console.log('SUB_CONTENT:')
    console.log(subText)

    const segLine = subText.split('\n').find((l) => l.trim() && !l.startsWith('#'))
    if (segLine) {
      const segUrl = new URL(segLine.trim(), subUrl).toString()
      console.log('SEG_URL:', segUrl)
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
