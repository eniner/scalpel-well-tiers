import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoe = JSON.parse(
  fs.readFileSync(path.join(path.dirname(root), 'repoe-base_items.min.json'), 'utf8'),
)
const bulk = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(root), 'scalpel-main/src/shared/data/trade/bulk-exchange-ids-poe2.json'),
    'utf8',
  ),
)

const skipName =
  /^(\[DNT|idol|legacy of|soul core of|.*thesis|.*gaze|emergent |carved |animus )/i

const fromRepoe = []
for (const item of Object.values(repoe)) {
  if (item.item_class !== 'SoulCore') continue
  const n = item.name
  if (!n || n.startsWith('[')) continue
  if (skipName.test(n)) continue
  if (!/rune/i.test(n)) continue
  fromRepoe.push(n)
}

const extra = [
  'Exalted Orb',
  'Chaos Orb',
  'Divine Orb',
  'Orb of Transmutation',
  'Orb of Augmentation',
  'Orb of Alchemy',
  "Gemcutter's Prism",
  "Glassblower's Bauble",
  "Lesser Jeweller's Orb",
  "Greater Jeweller's Orb",
  'Uncut Spirit Gem',
  'Uncut Skill Gem',
  'Uncut Support Gem',
  'Tempered Rune',
  'Lesser Tempered Rune',
  'Greater Tempered Rune',
]

const fromBulk = Object.keys(bulk).filter((k) => /rune/i.test(k))
const names = [...new Set([...fromRepoe, ...fromBulk, ...extra])].sort()

const out = {
  schemaVersion: 1,
  source: 'repoe-base_items+bulk-exchange-ids-poe2',
  names,
}

fs.writeFileSync(path.join(root, 'src/data/runeshape-rewards.json'), `${JSON.stringify(out, null, 2)}\n`)
console.log(`Wrote ${names.length} canonical runeshape reward names`)
