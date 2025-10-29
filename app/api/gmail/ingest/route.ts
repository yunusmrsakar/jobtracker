// app/api/gmail/ingest/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

/* ========== helpers ========== */
const toHay = (...p: (string | null | undefined)[]) =>
  p.filter(Boolean).join('\n').toLowerCase();

const hasAny = (t: string, list: string[]) => {
  const s = t.toLowerCase();
  return list.some((k) => s.includes(k.toLowerCase()));
};

const b64urlToUtf8 = (data: string) => {
  try {
    const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch { return ''; }
};

function decodeQP(input: string): string {
  if (!input) return '';
  let s = input.replace(/=\r?\n/g, '');
  s = s.replace(/=([A-Fa-f0-9]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return s;
}

// HTML → text (line-aware)
function stripHtml(html: string) {
  let s = html;
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|table|h[1-6])>/gi, '\n');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ');
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{2,}/g, '\n');
  return s.trim();
}

function extractBodyText(payload: any): string {
  if (!payload) return '';
  const texts: string[] = [];
  const walk = (part: any) => {
    if (!part) return;
    const mime = part.mimeType || '';
    const data = part.body?.data;

    if (data && (mime.startsWith('text/plain') || mime.startsWith('text/html'))) {
      let raw = b64urlToUtf8(data);
      if (/=0A|=3D|=\r?\n/.test(raw)) raw = decodeQP(raw);
      texts.push(mime.startsWith('text/html') ? stripHtml(raw) : raw);
    }
    (part.parts ?? []).forEach(walk);
  };
  walk(payload);

  if (texts.length === 0 && payload.body?.data) {
    let raw = b64urlToUtf8(payload.body.data);
    if (/=0A|=3D|=\r?\n/.test(raw)) raw = decodeQP(raw);
    texts.push(payload.mimeType?.startsWith('text/html') ? stripHtml(raw) : raw);
  }
  return texts.join('\n').trim();
}

const emailDomain = (fromLike: string) => {
  const m =
    fromLike.match(/<[^@<>]+@([^>\s]+)>/) ||
    fromLike.match(/[^@<\s]+@([^\s>]+)/);
  return (m?.[1] || '').toLowerCase();
};

// ‘·’ ayırıcısını KORU (Company · Location)
const clean = (s?: string) =>
  (s || '').replace(/\s+/g, ' ').replace(/[|•▶︎▸]+/g, ' ').trim();

const splitLines = (text: string) =>
  text.replace(/\r/g, '').split('\n').map((l) => clean(l)).filter(Boolean);

const getAfterLabel = (text: string, labels: string[]) => {
  const re = new RegExp(`(?:${labels.join('|')})\\s*[:\\-]\\s*([^\\n]+)`, 'i');
  const m = text.match(re);
  return m ? clean(m[1]) : undefined;
};

const findJobUrlLinkedIn = (t: string) => {
  const m = t.match(/https?:\/\/[^\s"']*linkedin\.com\/jobs\/view\/[^\s"')]+/i);
  return m ? m[0] : null;
};

// Role sonundaki (IMAC), (m/w/d), (f/m/x) vb’yi temizle
function cleanRole(role?: string): string {
  if (!role) return '';                 // <-- her zaman string döndür
  let r = role;
  r = r.replace(/\s*\((?:[A-Z]{2,8}|[A-Za-z\/\-]{2,12})\)\s*$/g, '');
  r = r.replace(/\s*\((?:m\/w\/d|f\/m\/x)\)\s*$/ig, '');
  return r.trim();
}
function normalizeRole(role?: string) {
  const rr = cleanRole(clean(role));    // cleanRole artık string döndürür
  return rr || undefined;               // normalizeRole yine undefined döndürebilir
}


/* ===== LinkedIn body-first extraction ===== */
type RC = { role?: string; company?: string; jobUrl?: string };

function looksCompanyLike(line: string) {
  return /^(?:[A-Z][\w&'().-]+(?:\s+[A-Z][\w&'().-]+){0,6})$/.test(line);
}

function pickRoleCompanyByCard(linesArr: string[]): { role?: string; company?: string } {
  const lines = linesArr.slice();
  const idxApplied = lines.findIndex((x) => /^applied on\b/i.test(x) || /^applied\b/i.test(x));
  if (idxApplied === -1) return {};

  let roleIdx = -1;
  for (let i = Math.max(0, idxApplied - 5); i < idxApplied; i++) {
    const a = lines[i];
    if (!a) continue;
    if (/^[-–—_]{5,}$/i.test(a)) continue;
    if (/^(your|now,|view similar|top jobs|regards|dear|hi|hello|your application|your update)/i.test(a)) continue;
    if (/:$/.test(a)) continue;
    if (/view job/i.test(a)) continue;
    if (a.split(' ').length <= 8 && /[A-Za-z]/.test(a)) roleIdx = i;
  }
  if (roleIdx === -1) return {};
  const role = cleanRole(lines[roleIdx]);

  const LOC_WORDS = [
    'remote','europe','european union','germany','deutschland','türkiye','turkey',
    'france','italy','spain','netherlands','poland','austria','switzerland',
    'united kingdom','uk','berlin','munich','hamburg','düsseldorf','köln','essen','neuss','cologne'
  ];

  for (let j = roleIdx + 1; j <= Math.min(lines.length - 1, roleIdx + 4); j++) {
    const b = lines[j];
    if (!b) continue;
    if (/view job/i.test(b)) continue;

    if (b.includes('·')) return { role, company: b.split('·')[0].trim() };

    const reLoc = new RegExp(`\\b(${LOC_WORDS.join('|')})\\b`, 'i');
    const m = b.match(reLoc);
    if (m && typeof m.index === 'number') {
      const name = b.slice(0, m.index).replace(/[ ,\-–—]+$/,'').trim();
      if (name) return { role, company: name };
    }

    const mAt = b.match(/^(?:at|bei)\s+([A-Z][\w&\-'(). ]{2,})/i);
    if (mAt) return { role, company: clean(mAt[1]) };

    if (looksCompanyLike(b)) return { role, company: b };
  }
  return { role };
}

function extractRoleCompanyFromBody(subject: string, body: string, source: string): RC {
  const bodyText = clean(body);
  const lines = splitLines(body);

  let companyFromHeader: string | undefined;
  const mh =
    bodyText.match(/\byour update from\s+([A-Z][A-Za-z0-9&().' -]{2,})\b/i) ||
    bodyText.match(/\byour application was sent to\s+([A-Z][A-Za-z0-9&().' -]{2,})\b/i);
  if (mh) companyFromHeader = clean(mh[1]);

  const roleLabel = getAfterLabel(`${body}\n${subject}`, [
    'job\\s*title','job\\s*role','position','role','title',
    'stelle','stellenbezeichnung','positionstitel'
  ]);
  const companyLabel = getAfterLabel(`${body}\n${subject}`, [
    'company','unternehmen','firma','employer'
  ]);

  const fromCard = pickRoleCompanyByCard(lines);

  let roleFromSent: string | undefined;
  let companyFromSent: string | undefined;
  const s3 =
    bodyText.match(/\bfor the (?:position|role) of\s+([A-Za-z0-9().,'&\-\/ ]{2,})\s+at\s+([A-Za-z0-9().,'&\-\/ ]{2,})/i) ||
    bodyText.match(/\bfor\s+([A-Za-z0-9().,'&\-\/ ]{2,})\s+at\s+([A-Za-z0-9().,'&\-\/ ]{2,})/i) ||
    bodyText.match(/\bfür die position\s+([A-Za-z0-9().,'&\-\/ ]{2,})\s+bei\s+([A-Za-z0-9().,'&\-\/ ]{2,})/i) ||
    bodyText.match(/\bfür\s+([A-Za-z0-9().,'&\-\/ ]{2,})\s+bei\s+([A-Za-z0-9().,'&\-\/ ]{2,})\b/i);
  if (s3) { roleFromSent = clean(s3[1]); companyFromSent = clean(s3[2]); }

  let companyFromAt: string | undefined;
  const atM = bodyText.match(/\bat\s+([A-Z][A-Za-z0-9&\-()'.\s]{2,})\s*(?:[.,]|$)/i);
  if (atM) companyFromAt = clean(atM[1]);
  const beiM = bodyText.match(/\bbei\s+([A-Z][A-Za-z0-9&\-()'.\s]{2,})\s*(?:[.,]|$)/i);
  if (beiM) companyFromAt = clean(beiM[1]) || companyFromAt;

  // subject fallback (AT/BEI + TİRELİ)
  let roleFromSubj: string | undefined, companyFromSubj: string | undefined;
  const subj = clean(subject);
  const sm =
    subj.match(/(.+?)\s+at\s+(.+)$/i) ||
    subj.match(/(.+?)\s+bei\s+(.+)$/i) ||
    subj.match(/(.+?)\s+[–—-]\s+(.+)$/);
  if (sm) { roleFromSubj = cleanRole(clean(sm[1])); companyFromSubj = clean(sm[2]); }

  const jobUrl = source === 'LinkedIn' ? findJobUrlLinkedIn(body) : null;

  let company =
    companyLabel || fromCard.company || companyFromSent || companyFromHeader || companyFromAt || companyFromSubj || undefined;

  let role =
    cleanRole(roleLabel) || cleanRole(fromCard.role) || cleanRole(roleFromSent) || cleanRole(roleFromSubj) || undefined;

  if (company) company = company.replace(/\s*·\s*.*$/, '').replace(/\s*view job.*$/i,'').trim();

  role = role ? clean(role) : undefined;
  company = company ? clean(company).replace(/^linkedin$/i, '') : undefined;

  if (company && company.length > 120) company = undefined;
  if (role && role.length > 140) role = undefined;

  return { role, company, jobUrl: jobUrl || undefined };
}

/* ===== kaynak & kalıplar ===== */
const SOURCE_BY_DOMAIN: Record<string, string> = {
  'linkedin.com': 'LinkedIn',
  'stepstone.de': 'StepStone',
  'stepstone.com': 'StepStone',
  'indeed.com': 'Indeed',
  'indeedemail.com': 'Indeed',
  'greenhouse.io': 'Greenhouse',
  'mail.greenhouse.io': 'Greenhouse',
  'lever.co': 'Lever',
  'hire.lever.co': 'Lever',
  'mg.lever.co': 'Lever',
  'personio.de': 'Personio',
  'personio.com': 'Personio',
  'smartrecruiters.com': 'SmartRecruiters',
  'teamtailor.com': 'Teamtailor',
  'recruitee.com': 'Recruitee',
  'workday.com': 'Workday',
  'myworkday.com': 'Workday',
  'bamboohr.com': 'BambooHR',
  'oraclecloud.com': 'Oracle Cloud',
  'join.com': 'Join',
  'jobvite.com': 'Jobvite',
  'icims.com': 'iCIMS',
  'successfactors.com': 'SuccessFactors',
  'eightfold.ai': 'Eightfold',
};

// Haber bülteni, özetler
const EXCLUDE_NEWSLETTER_KEYS = [
  'newsletter','daily digest','weekly digest','digest',
  'insights','this week','für diese woche','mitarbeiterbewertungen',
  'community','product hunt','the frontier',
  'medium daily','mark manson','substack','german career insights','freunde der zeit'
];

// Servis / güvenlik / muhasebe bildirimleri
const EXCLUDE_SERVICE_KEYS = [
  'auth','authentication','login code','magic link','verify your email',
  'security alert','password reset','device sign-in',
  'kundenbetreuung','rechnung','fatura','payment','billing','contract',
  'supabase auth'
];

// Randevu / takvim
const EXCLUDE_APPOINTMENT_KEYS: string[] = [];

// Sağlık/terapi (Hiwellapp vb.)
const EXCLUDE_HEALTH_APPT_KEYS = [
  'hiwellapp','therapy','therapist','psychologist','psychologie','psikolog','psikoloji',
  'terapi','seans','session started','video session','consultation','danışmanlık'
];

// Job advert / öneri / keşif mailleri
const EXCLUDE_JOB_ADVERT_KEYS = [
  'job advert','job advertisement','stellenanzeige','recommended jobs','jobs you might like',
  'top jobs','monetization jobs','new openings','career opportunities',
  'job suggestions','we found new jobs for you','vacancies','open positions','neue stellen'
];

// Job alert & digest
const EXCLUDE_ALERT_KEYS = [
  'job alert','stellenangebot','neue jobs','new jobs for you','job digest',
  'angebote der woche','gerade hereingekommen'
];

// Uygulama dışı gönderen domainleri (kesin dışla)
const EXCLUDE_NON_APPLICATION_SENDER_DOMAINS = [
  'hiwellapp.com','x.com','jobleads.com'
];

type Status = 'Applied' | 'Phone Screen' | 'Interview' | 'Offer' | 'Rejected' | 'Withdrawn';
const STATUS_WEIGHT: Record<Status, number> = { Applied:1, 'Phone Screen':2, Interview:3, Offer:4, Rejected:5, Withdrawn:6 };
const promote = (prev?: Status, incoming?: Status): Status =>
  (!prev ? (incoming || 'Applied') : (!incoming ? prev : (STATUS_WEIGHT[incoming] >= STATUS_WEIGHT[prev] ? incoming : prev)));

/* ===== company normalization & sender + THANKS fallback ===== */
const CITY_WORDS = [
  'remote','berlin','munich','münchen','hamburg','köln','cologne','düsseldorf','essen','neuss',
  'germany','deutschland','europe','european union','eu','emea','france','italy','spain','poland',
  'switzerland','austria','netherlands','uk','united kingdom','turkey','türkiye','hybrid'
];

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCompany(company?: string, role?: string) {
  if (!company) return undefined;
  let s = ' ' + company + ' ';

  // role kelimelerini ayıkla
  if (role) {
    const tokens = role.split(/\s+/).filter(Boolean);
    if (tokens.length) {
      const re = new RegExp(`\\b(${tokens.map(escapeRegExp).join('|')})\\b`, 'ig');
      s = s.replace(re, ' ');
    }
  }

  // kuyruklar
  s = s.replace(/\s*[,·|]\s*(view job.*)$/i, ' ');
  s = s.replace(/\s*view job.*$/i, ' ');

  // şehir/ülke/remote’ı sonda buda
  const locRe = new RegExp(`(?:[,\\s\\-–—]+(?:${CITY_WORDS.map(escapeRegExp).join('|')}))(?:[\\s\\w()./,-]*)$`, 'i');
  s = s.replace(locRe, ' ');

  // tekrar eden ardışık kelimeleri tekilleştir
  const words = s.trim().split(/\s+/);
  const dedup: string[] = [];
  for (const w of words) {
    if (dedup.length === 0 || dedup[dedup.length - 1].toLowerCase() !== w.toLowerCase()) dedup.push(w);
  }
  s = dedup.join(' ');

  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || undefined;
}

function companyFromSender(from: string): string | undefined {
  const m = from.match(/@([^>\s]+)>?$/) || from.match(/@([^\s>]+)/);
  const host = (m?.[1] || '').toLowerCase();
  if (!host) return;

  const ignore = [
    'workablemail.com','workable.com','greenhouse.io','mail.greenhouse.io','lever.co',
    'personio.de','personio.com','smartrecruiters.com','recruitee.com','teamtailor.com',
    'icims.com','oraclecloud.com','myworkday.com','workday.com','bamboohr.com'
  ];
  if (ignore.some(d => host.endsWith(d))) return;

  const parts = host.split('.');
  const sld = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  if (!sld) return;

  const pretty = sld.replace(/(^\w)/, c => c.toUpperCase());
  return pretty.replace(/([a-z])k$/i,'$1K'); // motork → MotorK
}

/* -------- THANK-YOU pattern → company (EN/DE/TR genişletilmiş) -------- */
function companyFromThanks(text: string): string | undefined {
  const t = (text || '').replace(/\s+/g, ' ');

  // İngilizce güçlü varyantlar
  const enPatterns: RegExp[] = [
    /\bthank you for your interest in joining\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
    /\bthank you for your interest in\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
    /\bthanks for your interest in\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
    /\bwe appreciate your interest in\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
    /\bthank you for your application to\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
    /\bthanks for applying to\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
    /\bthank you for applying to\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
    /\bthank you for your interest at\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
  ];

  for (const re of enPatterns) {
    const m = t.match(re);
    if (m) return clean(m[1]);
  }

  // Almanca
  const dePatterns: RegExp[] = [
    /\bvielen dank (?:für|fuer) (?:ihr|dein)e?n?\s+interesse an\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
    /\bvielen dank (?:für|fuer) (?:ihr|dein)e?n?\s+interesse an einer tätigkeit bei\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
    /\bvielen dank (?:für|fuer) (?:ihr|dein)e?n?\s+bewerbung bei\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
    /\bwir danken (?:ihnen|dir) (?:für|fuer) (?:ihr|dein)e?n?\s+interesse an\s+([A-Z][A-Za-z0-9&().,'\- ]{2,})\b/i,
  ];
  for (const re of dePatterns) {
    const m = t.match(re);
    if (m) return clean(m[1]);
  }

  // Türkçe
  const trPatterns: RegExp[] = [
    /\b(?:firmamıza|şirketimize|ekibimize)?\s*ilginiz için teşekkür(?:ler| ederiz)\s*,?\s*([A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜ0-9&().,'\- ]{2,})\b/i,
    /\bbaşvurunuz için teşekkür(?:ler| ederiz)\s*,?\s*([A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜ0-9&().,'\- ]{2,})\b/i,
    /\b(?:[A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜ0-9&().,'\- ]{2,})\s*ailesine ilginiz için teşekkür(?:ler| ederiz)\b/i,
  ];
  for (const re of trPatterns) {
    const m = t.match(re);
    if (m) return clean(m[1]);
  }

  return undefined;
}

/* ===== akıllı eşleştirme (normalized) ===== */
function subjectRoot(s: string) {
  const x = s.replace(/\s+\(.+?\)\s*$/,'');
  return x.split(' - ')[0].split(' — ')[0].split(' – ')[0].trim();
}

function escapeSQLLiteral(s: string) { return `'${s.replace(/'/g, "''")}'`; }
function escapeSQLIdent(s: string) { return s.replace(/"/g, '""'); }

type DBAppRowLite = {
  id: number | string;
  status: Status;
  company?: string | null;
  role?: string | null;
  created_at?: string | null;
};

async function findExistingApplicationNormalized(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  threadId: string | undefined,
  nCompany?: string,
  nRole?: string,
  subject?: string
) {
  // 1) thread_id
  if (threadId) {
    const { data } = await supabase
      .from('job_applications')
      .select('id, status')
      .eq('user_id', userId)
      .eq('thread_id', threadId)
      .limit(1);
    if (data && (data as any[])[0]) return (data as any[])[0] as DBAppRowLite;
  }

  const since = new Date(Date.now() - 60*24*60*60*1000).toISOString();

  // 2) company/role yakın eşleşme
  if (nCompany) {
    const { data } = await supabase
      .from('job_applications')
      .select('id, status, company, role, created_at')
      .eq('user_id', userId)
      .gte('created_at', since)
      .or([
        `company.ilike.%${nCompany}%`,
        `${escapeSQLIdent('company')} = ${escapeSQLLiteral(nCompany)}`,
      ].join(','))
      .order('created_at', { ascending: false })
      .limit(10);

    const rows = (data ?? []) as DBAppRowLite[]; // <<< TİP DÜZELTME
    if (rows.length) {
      const cand = rows.find(r => {
        const c = (r.company || '').toLowerCase();
        const rc = (nCompany || '').toLowerCase();
        const roleDb = (r.role || '').toLowerCase();
        const nr = (nRole || '').toLowerCase();
        const companyClose = c.includes(rc) || rc.includes(c);
        const roleClose = !nr || !roleDb || roleDb.includes(nr) || nr.includes(roleDb);
        return companyClose && roleClose;
      });
      if (cand) return cand;
    }
  }

  // 3) subject kökü ile role eşleşmesi
  const root = subject ? subjectRoot(subject) : undefined;
  if (root && !nCompany) {
    const { data } = await supabase
      .from('job_applications')
      .select('id, status, company, role, created_at')
      .eq('user_id', userId)
      .gte('created_at', since)
      .ilike('role', `%${root}%`)
      .order('created_at', { ascending: false })
      .limit(1);

    const rows = (data ?? []) as DBAppRowLite[]; // <<< TİP DÜZELTME
    if (rows[0]) return rows[0];
  }

  return null;
}

/* ========== API ========== */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader) return NextResponse.json({ ok:false, error:'not_auth' }, { status:401 });

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok:false, error:'not_auth' }, { status:401 });

    const { data: tokenRow } = await supabase.from('gmail_tokens').select('*').eq('user_id', user.id).maybeSingle();
    if (!tokenRow) return NextResponse.json({ ok:false, error:'no_gmail_link' }, { status:400 });

    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );
    oauth2.setCredentials({
      access_token: tokenRow.access_token,
      refresh_token: tokenRow.refresh_token ?? undefined,
      expiry_date: tokenRow.expiry_date ?? undefined,
      token_type: 'Bearer',
    });
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });

    const url = new URL(req.url);
    const MAX_TO_FETCH = Math.min(parseInt(url.searchParams.get('limit') || '300', 10), 600);
    const days = parseInt(url.searchParams.get('days') || '180', 10);
    const query = [`newer_than:${days}d`, 'in:inbox', '-category:social', '-category:promotions'].join(' ');

    const ids: string[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    while (ids.length < MAX_TO_FETCH && pageCount < 10) {
      const list = await gmail.users.messages.list({ userId:'me', q:query, maxResults:100, pageToken, includeSpamTrash:false });
      (list.data.messages ?? []).forEach(m => m.id && ids.push(m.id));
      pageToken = list.data.nextPageToken || undefined;
      pageCount++;
      if (!pageToken) break;
    }
    if (!ids.length) return NextResponse.json({ ok:true, imported:0, scanned:0, skippedBy:{ no_ids_from_gmail:1 }, usedQuery:query });

    let imported = 0;
    const skippedBy: Record<string, number> = {};
    const skip = (r: string) => (skippedBy[r] = (skippedBy[r] || 0) + 1);

    for (const id of ids.slice(0, MAX_TO_FETCH)) {
      const msg = await gmail.users.messages.get({ userId:'me', id, format:'full' });
      const headers = (msg.data.payload?.headers ?? []) as Array<{name:string; value:string}>;
      const getH = (n: string) => headers.find(h => h.name?.toLowerCase() === n.toLowerCase())?.value ?? '';

      const subject = getH('Subject') || '';
      const from = getH('From') || '';
      const returnPath = getH('Return-Path') || '';
      const replyTo = getH('Reply-To') || '';
      const dateStr = getH('Date') || '';
      const threadId = msg.data.threadId || '';
      const gmailLinkId = msg.data.id || ''; // gmail_id
      const gmailLink = gmailLinkId ? `https://mail.google.com/mail/u/0/#all/${gmailLinkId}` : null;

      const body = extractBodyText(msg.data.payload);
      const txtAll = toHay(subject, body, from, returnPath, replyTo);

      const fromDom = emailDomain(from);

      // ——— erken dışlama: domain bazlı ———
      if (fromDom && EXCLUDE_NON_APPLICATION_SENDER_DOMAINS.some(d => fromDom.endsWith(d))) {
        skip('non_application_domain');
        continue;
      }

      // ——— içerik bazlı dışlama ———
      if (hasAny(txtAll, EXCLUDE_HEALTH_APPT_KEYS))   { skip('health_or_therapy_notice'); continue; }
      if (hasAny(txtAll, EXCLUDE_APPOINTMENT_KEYS))   { skip('appointment_notice');       continue; }
      if (hasAny(txtAll, EXCLUDE_NEWSLETTER_KEYS))    { skip('newsletter');               continue; }
      if (hasAny(txtAll, EXCLUDE_SERVICE_KEYS))       { skip('service_notice');           continue; }
      if (hasAny(txtAll, EXCLUDE_ALERT_KEYS) || hasAny(txtAll, EXCLUDE_JOB_ADVERT_KEYS)) {
        skip('job_advert_or_alert');
        continue;
      }

      const isRejected  = hasAny(txtAll, ['we will not move forward','not moving forward','unfortunately we will not','no longer under consideration',
        'regret to inform you','decided not to move forward','will not proceed','leider','absage','nicht weiter',
        'olumsuz değerlendirildi','üzgünüz'
      ]);
      const isInterview = hasAny(txtAll, [
        'interview','phone screen','technical interview','onsite','gespräch','vorstellungsgespräch','telefoninterview',
        'mülakat','görüşme','schedule a call','book a call','calendly'
      ]);
      const strong      = hasAny(txtAll, [
        'application received','we received your application','thank you for applying','your application to',
        'ihre bewerbung','bewerbung eingegangen','wir haben deine bewerbung erhalten','bestätigung ihrer bewerbung'
      ]);
      const medium      = hasAny(txtAll, ['application','applied','bewerbung','postulation','candidature','confirm your email','confirm your mail']);

      let status: Status | undefined;
      if (isRejected) status = 'Rejected';
      else if (isInterview) status = 'Interview';
      else if (strong || medium) status = 'Applied';

      const senderBlob = `${from} ${returnPath} ${replyTo}`.toLowerCase();
      let source = fromDom ? (Object.entries(SOURCE_BY_DOMAIN).find(([d]) => fromDom.endsWith(d))?.[1] ?? 'Other') : 'Other';
      const isKnownATS = Object.keys(SOURCE_BY_DOMAIN).some(dom => senderBlob.includes(dom) || (fromDom ? fromDom.endsWith(dom) : false));
      if (!status && isKnownATS) status = 'Applied';
      if (!status) { skip('no_positive_signal'); continue; }

      // BODY-first çıkarım
      const rc = extractRoleCompanyFromBody(subject, body, source);
      let company = rc.company || '';
      let role = rc.role || '';

      // subject fallback (AT/BEI + tireli)
// subject fallback (AT/BEI + tireli)
if ((!company || company === '(Unknown)') && subject) {
  const ssub = clean(subject);
  const sm =
    ssub.match(/(.+?)\s+at\s+(.+)$/i) ||
    ssub.match(/(.+?)\s+bei\s+(.+)$/i) ||
    ssub.match(/(.+?)\s+[–—-]\s+(.+)$/);

  if (sm) {
    const [, mRole, mCompany] = sm as RegExpMatchArray; // grupları kesinleştir
    role    = role    || cleanRole(clean(mRole ?? '')) || '';
    company = company || clean(mCompany ?? '')          || '';
  }
}


      // Hâlâ company yoksa gönderen domaininden türet
      if (!company) {
        const fromCompany = companyFromSender(from);
        if (fromCompany) company = fromCompany;
      }

      // normalize
      const nRole = normalizeRole(role) || '(Unknown)';
      const nCompany = normalizeCompany(company, role) || '(Unknown)';

      const jobUrl = rc.jobUrl || null;
      const apply_date = dateStr ? new Date(dateStr).toISOString().slice(0,10) : null;

      // ----- eşleştirme (normalized) & upsert -----
      let applicationId: number | null = null;
      let prevStatus: Status | undefined;

      const existing = await findExistingApplicationNormalized(
        supabase, user.id, threadId, nCompany !== '(Unknown)' ? nCompany : undefined,
        nRole !== '(Unknown)' ? nRole : undefined, subject
      );
      if (existing) {
        applicationId = (existing as any).id as number;
        prevStatus = (existing as any).status as Status;
      }

      const finalStatus = promote(prevStatus, status);

      if (applicationId == null) {
        const ins = await supabase.from('job_applications').insert({
          user_id: user.id,
          gmail_id: gmailLinkId || null,   // <<<< gmail_id kayıt
          thread_id: threadId,
          company: nCompany,
          role: nRole,
          source,
          status: finalStatus,
          apply_date,
          notes: `Imported from Gmail: ${subject}`,
          job_url: jobUrl
        }).select('id').single();
        if (ins.error) { skip(`insert_error_${ins.error.code || 'unknown'}`); continue; }
        applicationId = (ins.data as any).id as number; imported++;
      } else {
        const updPayload: any = { status: finalStatus, apply_date, updated_at: new Date().toISOString() };
        if (gmailLinkId) updPayload.gmail_id = gmailLinkId;     // <<<< mevcut kayda gmail_id yaz
        if (nCompany && nCompany !== '(Unknown)' && !/^linkedin$/i.test(nCompany)) updPayload.company = nCompany;
        if (nRole && nRole !== '(Unknown)') updPayload.role = nRole;
        if (jobUrl) updPayload.job_url = jobUrl;
        const upd = await supabase.from('job_applications').update(updPayload).eq('id', applicationId);
        if (upd.error) { skip(`update_error_${upd.error.code || 'unknown'}`); continue; }
      }

      // e-posta log tablosu (opsiyonel)
      await supabase.from('job_application_emails').insert({
        user_id: user.id,
        application_id: applicationId!,
        gmail_id: gmailLinkId || null,
        subject,
        sent_at: dateStr ? new Date(dateStr).toISOString() : null,
        gmail_link: gmailLink
      });
    }

    return NextResponse.json({ ok:true, imported, scanned: Math.min(ids.length, MAX_TO_FETCH), skippedBy, usedQuery: query });
  } catch (e: any) {
    return NextResponse.json({ ok:false, error: e?.message || String(e) }, { status:500 });
  }
}
