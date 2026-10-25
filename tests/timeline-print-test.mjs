// The printed timeline for suppliers (src/portal/timelineShared.js).
//   node tests/timeline-print-test.mjs
import { timelinePrintHtml, mergeDay } from '../src/portal/timelineShared.js'

let pass = 0, fail = 0
const ok = (label, cond, extra) => { if (cond) pass++; else { fail++; console.log('FAIL ' + label + (extra ? '\n  ' + extra : '')) } }

const timeline = {
  days: [
    { day_key: 'before', label: 'Friday', fixed: [], access_text: 'from 2pm' },
    { day_key: 'event', label: 'The day', fixed: [{ time: '23:45:00', title: 'Bar closes' }, { time: '00:30:00', title: 'Site closed' }] },
    { day_key: 'after', label: 'Sunday', fixed: [] },
  ],
  blocks: [
    { id: 'a', day_key: 'event', start_time: '14:00:00', duration_min: 45, title: 'Ceremony', notes: 'In the orchard\nif dry', supplier_name: null, contact_name: 'Uncle Bob' },
    { id: 'b', day_key: 'event', start_time: '23:30:00', duration_min: 15, title: 'Speeches <script>', notes: null, supplier_name: 'Band & Co' },
    { id: 'c', day_key: 'event', start_time: '00:15:00', duration_min: null, title: 'Carriages', notes: null },
    { id: 'd', day_key: 'event', start_time: '18:00:00', duration_min: 30, title: 'First dance', prompts: 'Song?\nWho starts?', answers: ['Moon River', ''] },
    { id: 'e', day_key: 'before', start_time: '15:00:00', duration_min: 120, title: 'Set up' },
  ],
}
const html = timelinePrintHtml({
  eventName: 'Sam & Alex', eventDate: '12 Jun 2027', timeline,
  contacts: [{ name: 'Uncle Bob', role: 'Usher', phone: '07700 900123', note: 'Has the rings' }],
  suppliers: [{ name: 'Band & Co', category: 'music', contact_name: 'Jo', phone: '01234', email: 'jo@band.test' }],
  categories: [{ slug: 'music', label: 'Music' }],
})

ok('title escaped', html.includes('<h1>Sam &amp; Alex</h1>'))
ok('every day with lines, in order; the empty day left out',
  html.indexOf('Friday') < html.indexOf('The day') && !html.includes('Sunday'))
ok('access text shown', html.includes('Access from 2pm'))
const iCer = html.indexOf('Ceremony'), iSp = html.indexOf('Speeches'), iBar = html.indexOf('Bar closes'), iCar = html.indexOf('Carriages'), iSite = html.indexOf('Site closed')
ok('after midnight sorts to the end of the day, venue lines woven in', iCer < iSp && iSp < iBar && iBar < iCar && iCar < iSite, [iCer, iSp, iBar, iCar, iSite].join(','))
ok('start–end times', html.includes('14:00–14:45'))
ok('venue lines marked', html.includes('Bar closes <em>(the venue)</em>'))
ok('who is responsible', html.includes('Band &amp; Co') && html.includes('Uncle Bob'))
ok('couple text escaped, never markup', html.includes('Speeches &lt;script&gt;') && !html.includes('Speeches <script>'))
ok('notes keep their line breaks', html.includes('In the orchard<br>if dry'))
ok('answered questions only', html.includes('Song? <b>Moon River</b>') && !html.includes('Who starts?'))
ok('people to ring with phone and note', html.includes('On the day, ring') && html.includes('07700 900123') && html.includes('Has the rings'))
ok('suppliers with category and contact', html.includes('<div class="n">Music</div>') && html.includes('jo@band.test'))
ok('prints itself on open', html.includes('window.print()'))

const empty = timelinePrintHtml({ eventName: 'X', timeline: { days: [{ day_key: 'event', label: 'The day', fixed: [] }], blocks: [] } })
ok('an empty timeline says so', empty.includes('Nothing on the timeline yet'))
ok('no contacts or suppliers, no empty headings', !empty.includes('On the day, ring') && !empty.includes('Suppliers'))

ok('mergeDay still exported for the page', mergeDay([{ start_time: '10:00' }], [{ time: '09:00', title: 'Gates' }])[0].kind === 'venue')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
