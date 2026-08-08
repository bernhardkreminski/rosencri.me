/**
 * Ground truth for the OCR regression harness (dev/ocr-batch.html).
 *
 * Six real images, all live on the board, transcribed BY HAND from the
 * originals — not from any OCR output. They were chosen because they are the
 * inputs the pipeline actually gets and the ones it actually fails on:
 * two Instagram screenshots (phone chrome + unrelated feed content), a
 * hand-lettered flyer, a website screenshot, a printed poster, and a dense
 * programme table.
 *
 * `mustNot` is as important as `must`. Both screenshots carry a clock in the
 * status bar, and the phone clock being read as the event time is a real,
 * observed failure — the Alpinflohmarkt event went live with 08:00 (status bar
 * "08:27") instead of the 09:00 printed on the flyer.
 *
 * Dates are matched on month+day only. Two flyers give no year, so the
 * resolved year depends on when the scan happens; that is scored separately.
 */

export const FIXTURES = [
  {
    slug: 'alpinflohmarkt',
    label: 'Alpinflohmarkt (Instagram screenshot)',
    imageUrl: 'https://pyftcvikhuzleqxjsecn.supabase.co/storage/v1/object/public/posters/1785825087749-8ff204bc.jpg',
    hazards: ['instagram chrome', 'status-bar clock 08:27', 'unrelated ad above the post'],
    expect: {
      title: { any: ['alpinflohmarkt'] },
      monthDay: '10-25',
      startTime: '09:00',
      endTime: '14:00',
      url: { any: ['alpenverein_muenchen_oberland'] },
      tags: ['flohmarkt'],
    },
    mustNot: ['organicbasics', 'maXXim', '08:27', 'Feel confident', 'intimates'],
  },
  {
    slug: 'h3cke',
    label: 'H3CKE Makerspace — 1 Jahr Jubiläum (hand-lettered flyer)',
    imageUrl: 'https://pyftcvikhuzleqxjsecn.supabase.co/storage/v1/object/public/posters/1785865098166-0359c7a0.jpg',
    hazards: ['hand-lettered display font', 'text wrapped around illustrations'],
    expect: {
      title: { any: ['jubil', 'h3cke', 'jahr'] },
      monthDay: '08-23',
      startTime: '10:00',
      endTime: '22:00',
      location: { any: ['h3cke', 'makerspace', 'rosenheim'] },
      tags: [],
    },
    mustNot: [],
  },
  {
    slug: 'flohmarkt-stoa',
    label: 'Flohmarkt Am Stoa (Instagram screenshot, dark)',
    imageUrl: 'https://pyftcvikhuzleqxjsecn.supabase.co/storage/v1/object/public/posters/1785962656259-cfbdffeb.jpg',
    hazards: ['browser + instagram chrome', 'status-bar clock 22:42', 'suggested-account row below'],
    expect: {
      title: { any: ['flohmarkt'] },
      monthDay: '08-22',
      // The flyer reads "Samstag, 22.8. - 13 Uhr" and separately "Einfahrt bis
      // 12:30 Uhr möglich". Whether 13:00 is the start or the end is genuinely
      // ambiguous on the flyer itself, so either placement scores as a pass —
      // what must NOT happen is a time that appears nowhere on it.
      timeAnywhere: '13:00',
      tags: ['flohmarkt'],
    },
    mustNot: ['22:42', 'sportymarlena', 'Für dich', 'vorgeschlagen'],
  },
  {
    slug: 'fabi-maegel',
    label: 'Feierabendkonzert mit Fabi Maegel (website screenshot)',
    imageUrl: 'https://pyftcvikhuzleqxjsecn.supabase.co/storage/v1/object/public/posters/1785302762754-b407cd6f.jpg',
    hazards: ['status-bar clock 07:21', 'extra dates in prose, not in a date field'],
    expect: {
      title: { any: ['feierabendkonzert', 'fabi'] },
      monthDay: '08-05',
      startTime: '18:00',
      endTime: '19:00',
      location: { any: ['salzstadel'] },
      // "Weitere Termine: 19.08., 16.09., 30.09." — a series stated in prose.
      extraDates: ['08-19', '09-16', '09-30'],
      tags: ['konzert'],
    },
    mustNot: ['07:21'],
  },
  {
    slug: 'kulturstrand',
    label: 'Rosenheimer Kultur-Strand (printed poster)',
    imageUrl: 'https://pyftcvikhuzleqxjsecn.supabase.co/storage/v1/object/public/posters/1785303175794-2407985d.jpg',
    hazards: ['distressed/textured display type', 'time printed inside a small rotated badge'],
    expect: {
      title: { any: ['kultur'] },
      monthDay: '07-30',
      startTime: '17:00',
      location: { any: ['innspitz'] },
      url: { any: ['rosenheim.jetzt', 'kulturstrand_rosenheim'] },
      tags: ['open-air'],
    },
    mustNot: [],
  },
  {
    slug: 'freiluftkino',
    label: 'Freiluftkino am Stoa 2026 (dense programme table)',
    imageUrl: 'https://pyftcvikhuzleqxjsecn.supabase.co/storage/v1/object/public/posters/1785963162382-beeee78c.jpg',
    hazards: ['two-column table of ~40 dated rows', 'no single event time on the sheet'],
    expect: {
      title: { any: ['freiluftkino'] },
      monthDay: '07-04',
      // Deliberately no expected time: the sheet prints none for the run as a
      // whole. Asserting one would be an invention, so the pass condition is
      // that the pipeline does NOT confidently claim a start time.
      noConfidentTime: true,
      url: { any: ['kino-utopia'] },
      tags: ['kino'],
    },
    mustNot: [],
  },
];
