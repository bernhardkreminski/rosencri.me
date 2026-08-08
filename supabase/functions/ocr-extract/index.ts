/**
 * ocr-extract — poster image → event fields, via a vision model.
 *
 * WHY THIS EXISTS
 * ---------------
 * The board is a static site with no server, so until now OCR ran entirely in
 * the browser on Tesseract. Measured against six real uploads that are live on
 * the board, that pipeline scored 19/43 on hand-checked ground truth: it never
 * read the hand-lettered H3CKE flyer at all (no date, no time, 71s of work),
 * lost four of six titles, and took the phone's status-bar clock (22:42) as the
 * start time of a flea market. Those are recognition and comprehension
 * failures, not parser bugs — see documentation/ocr.md.
 *
 * This function is the path `documentation/decisions.md#tesseract-only`
 * reserved for exactly this moment: "a Supabase Edge Function holding an API
 * key server-side, with Tesseract as the offline fallback."
 *
 * WHY A FUNCTION AND NOT A DIRECT CALL
 * ------------------------------------
 * A static site cannot keep a secret. An API key shipped in client JS is
 * readable by every visitor and gets scraped within hours. The key lives here,
 * in Supabase's encrypted secret store, and never reaches the browser.
 *
 * SECURITY POSTURE
 * ----------------
 * The board has no login by design, so there is no user to attribute a request
 * to. Abuse control is therefore best-effort and layered: a hard cap on image
 * bytes, and a per-IP daily quota kept in Postgres. A determined attacker with
 * many IPs can still burn quota; the mitigation for that is a captcha, which is
 * deliberately not built yet (see documentation/ocr.md).
 */

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
// Overridable without a redeploy: model ids move, and the free tier's roster
// changes. `-latest` aliases track the current generation of the family.
const MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-flash-lite-latest';

/** Gemini rejects very large inline payloads, and the free tier is metered by
 *  token count, which scales with pixels. The client downscales before sending;
 *  this is the backstop. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Per-IP, per-UTC-day. Generous for a person, cheap to absorb from a bot. */
const DAILY_IP_QUOTA = Number(Deno.env.get('OCR_DAILY_IP_QUOTA') ?? '40');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

/**
 * What we want out of the image. Written as instructions to a reader rather
 * than as a parsing spec, because the failures being fixed here are judgement
 * calls a regex cannot make: which of several dates is *the* date, whether a
 * clock belongs to the poster or to the phone that photographed it.
 */
function buildPrompt(todayISO: string): string {
  return `Du liest ein Bild, das jemand auf ein Veranstaltungs-Board für Rosenheim (Bayern) hochgeladen hat, und extrahierst daraus die Daten EINER Veranstaltung.

Heutiges Datum: ${todayISO}. Nutze es, um ein fehlendes Jahr zu ergänzen: wähle das Jahr so, dass die Veranstaltung in der Zukunft oder in den letzten Wochen liegt — niemals mehr als ein Jahr in der Zukunft.

Das Bild ist oft KEIN reines Plakat, sondern ein Screenshot (Instagram, Browser, Website). Dann gilt:
- Ignoriere die Bedienoberfläche des Telefons und der App vollständig: Statusleiste mit Uhrzeit, Akku, Mobilfunkanbieter, Adressleiste, Navigationsleiste, Like-/Kommentarzahlen, "Für dich", "Folgen", Vorschläge.
- Die Uhrzeit in der Statusleiste ist WANN DER SCREENSHOT GEMACHT WURDE. Sie ist niemals die Uhrzeit der Veranstaltung.
- Beiträge anderer Konten, Werbung und angeschnittener Text über oder unter dem eigentlichen Beitrag gehören nicht dazu.

Regeln:
- Erfinde nichts. Wenn etwas nicht im Bild steht, gib null bzw. "" zurück. Eine geratene Uhrzeit ist schlimmer als gar keine.
- startTime nur, wenn eine Anfangszeit tatsächlich abgedruckt ist. "Einlass"/"Start"/"Beginn" ist die Anfangszeit; "Livemusik ab …" ist es nur, wenn keine andere genannt wird.
- Bei einer Zeitspanne ("10-22 Uhr", "18 bis 19 Uhr", "Verkauf von 09:00 - 14:00") setze startTime und endTime.
- Ein Datumsbereich ("4.7.26 – 27.9.26", "30. Juli bis 22. August") ist KEINE Uhrzeit. Setze dann startDate auf den ersten Tag und untilDate auf den letzten.
- Nennt das Bild weitere Termine derselben Reihe ("Weitere Termine: 19.08., 16.09."), liste sie in furtherDates.
- Beschreibt es einen Rhythmus ("Donnerstag – Samstag", "jeden Mittwoch"), gib ihn in recurrenceNote in eigenen Worten wieder.
- title ist der Name der Veranstaltung, ohne Datum und ohne "Save the Date".
- location ist der Veranstaltungsort (Name oder Adresse), nicht die Stadt allein.
- description: 1–3 kurze Sätze aus dem tatsächlichen Text des Bildes. Keine Bedienoberfläche, keine Wiederholung von Titel/Datum.
- tags: wenige Kleinbuchstaben-Schlagwörter aus dieser Liste, soweit zutreffend: konzert, festival, party, flohmarkt, kino, film, lesung, theater, ausstellung, workshop, voku, kufa, soli, open-air, biergarten, kinder, diy, punk, rock, indie, jazz, folk, techno, hiphop, metal, hardcore, live-musik.
- notes: was du NICHT sicher lesen konntest, in einem kurzen deutschen Satz. Leer lassen, wenn alles klar war.`;
}

/** Gemini structured-output schema (OpenAPI subset). */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    startDate: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD' },
    startTime: { type: 'STRING', nullable: true, description: 'HH:MM, 24h' },
    endTime: { type: 'STRING', nullable: true, description: 'HH:MM, 24h' },
    untilDate: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD, last day of a run' },
    furtherDates: { type: 'ARRAY', items: { type: 'STRING' }, description: 'YYYY-MM-DD' },
    recurrenceNote: { type: 'STRING' },
    location: { type: 'STRING' },
    description: { type: 'STRING' },
    url: { type: 'STRING' },
    tags: { type: 'ARRAY', items: { type: 'STRING' } },
    notes: { type: 'STRING' },
  },
  required: ['title', 'startDate', 'startTime', 'location', 'description', 'tags'],
};

/**
 * Per-IP daily quota, counted in Postgres.
 *
 * Reads the caller address from the platform-set forwarding header, never from
 * anything the client can choose — a client-supplied identifier would make the
 * whole check self-defeating. Fails OPEN: if the counter table is unreachable
 * the request proceeds, because losing OCR entirely is a worse outcome than
 * briefly losing the quota ceiling.
 */
async function checkQuota(req: Request): Promise<{ ok: boolean; used: number }> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return { ok: true, used: 0 };

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const day = new Date().toISOString().slice(0, 10);

  try {
    const resp = await fetch(`${url}/rest/v1/rpc/bump_ocr_usage`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_ip: ip, p_day: day }),
    });
    if (!resp.ok) return { ok: true, used: 0 };
    const used = Number(await resp.json());
    return { ok: used <= DAILY_IP_QUOTA, used };
  } catch {
    return { ok: true, used: 0 };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return json({ error: 'not_configured', message: 'GEMINI_API_KEY is not set' }, 503);

  let body: { imageBase64?: string; mimeType?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request', message: 'expected JSON' }, 400);
  }

  const { imageBase64, mimeType } = body;
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return json({ error: 'bad_request', message: 'imageBase64 is required' }, 400);
  }
  // base64 inflates by 4/3; compare against the decoded size.
  if ((imageBase64.length * 3) / 4 > MAX_IMAGE_BYTES) {
    return json({ error: 'too_large', message: 'image exceeds 4 MB' }, 413);
  }
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mimeType ?? '')) {
    return json({ error: 'bad_request', message: 'unsupported mimeType' }, 400);
  }

  const quota = await checkQuota(req);
  if (!quota.ok) {
    return json(
      { error: 'rate_limited', message: `Tageslimit erreicht (${DAILY_IP_QUOTA}).`, used: quota.used },
      429,
    );
  }

  const todayISO = new Date().toISOString().slice(0, 10);
  const started = Date.now();

  let upstream: Response;
  try {
    upstream = await fetch(`${GEMINI_ENDPOINT}/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: buildPrompt(todayISO) },
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          // Deterministic-ish: this is extraction, not writing.
          temperature: 0,
        },
      }),
    });
  } catch (err) {
    return json({ error: 'upstream_unreachable', message: String(err) }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    // Surfaced verbatim so a wrong model id or an exhausted quota is
    // diagnosable from the client instead of looking like a generic failure.
    return json({ error: 'upstream_error', status: upstream.status, detail: detail.slice(0, 800) }, 502);
  }

  const payload = await upstream.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return json({ error: 'empty_response', detail: JSON.stringify(payload).slice(0, 800) }, 502);

  let extracted: Record<string, unknown>;
  try {
    extracted = JSON.parse(text);
  } catch {
    return json({ error: 'unparsable_response', detail: String(text).slice(0, 800) }, 502);
  }

  return json({
    ok: true,
    model: MODEL,
    durationMs: Date.now() - started,
    extracted,
  });
});
