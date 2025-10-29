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

// Temizlik (genel)
const clean = (s?: string) =>
  (s || '').replace(/\s+/g, ' ').replace(/[|•▶︎▸]+/g, ' ').trim();

function cleanRole(role?: string) {
  if (!role) return role;
  let r = role;
  r = r.replace(/\s*\((?:[A-Z]{2,8}|[A-Za-z\/\-]{2,12})\)\s*$/g, '');
  r = r.replace(/\s*\((?:m\/w\/d|f\/m\/x)\)\s*$/ig, '');
  return r.trim();
}
function normalizeRole(role?: string) {
  return role ? cleanRole(clean(role)) : undefined;
}

const findJobUrlLinkedIn = (t: string) => {
  const m = t.match(/https?:\/\/[^\s"']*linkedin\.com\/jobs\/view\/[^\s"')]+/i);
  return m ? m[0] : null;
}

/* ===== LinkedIn body-first extraction (rol & url; company artık subject@sender) ===== */
type RC = { role?: string; jobUrl?: string };
function pickRoleCompanyByCard(linesArr: string[]): { role?: string } {
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
  return { role: cleanRole(lines[roleIdx]) };
}

function extractRoleFromBody(subject: string, body: string, source: string): RC {
  const bodyText = clean(body);
  const lines = bodyText.replace(/\r/g, '').split('\n').map(clean).filter(Boolean);

  const fromCard = pickRoleCompanyByCard(lines);

  // cümle bazlı rol (company'i artık subject/sender'dan kuruyoruz)
  const s3 =
    bodyText.match(/\bfor the (?:position|role) of\s+([A-Za-z0-9().,'&\-\/ ]{2,})\s+at\s+[A-Za-z0-9().,'&\-\/ ]{2,}/i) ||
    bodyText.match(/\bfor\s+([A-Za-z0-9().,'&\-\/ ]{2,})\s+at\s+[A-Za-z0-9().,'&\-\/ ]{2,}/i) ||
    bodyText.match(/\bfür die position\s+([A-Za-z0-9().,'&\-\/ ]{2,})\s+bei\s+[A-Za-z0-9().,'&\-\/ ]{2,}/i) ||
    bodyText.match(/\bfür\s+([A-Za-z0-9().,'&\-\/ ]{2,})\s+bei\s+[A-Za-z0-9().,'&\-\/ ]{2,}/i);

  const roleFromSent = s3 ? cleanRole(clean(s3[1])) : undefined;

  // subject bazlı rol (e.g. "Product Manager — Company")
  const subj = clean(subject);
  let roleFromSubj: string | undefined;
  const sm =
    subj.match(/(.+?)\s+at\s+(.+)$/i) ||
    subj.match(/(.+?)\s+bei\s+(.+)$/i) ||
    subj.match(/(.+?)\s+[–—-]\s+(.+)$/);
  if (sm) roleFromSubj = cleanRole(clean(sm[1]));

  const jobUrl = source === 'LinkedIn' ? findJobUrlLinkedIn(body) : null;
  const role = cleanRole(fromCard.role || roleFromSent || roleFromSubj || undefined);

  return { role: role || undefined, jobUrl: jobUrl || undefined };
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

const STRONG_POSITIVE = [
  'application received','we received your application','thank you for applying','your application to',
  'ihre bewerbung','bewerbung eingegangen','wir haben deine bewerbung erhalten','bestätigung ihrer bewerbung'
];
const MEDIUM_POSITIVE = ['application','applied','bewerbung','postulation','candidature','confirm your email','confirm your mail'];
const REJECTION_KEYS = [
  'we will not move forward','not moving forward','unfortunately we will not','no longer under consideration',
  'regret to inform you','decided not to move forward','will not proceed','leider','absage','nicht weiter',
  'olumsuz değerlendirildi','üzgünüz'
];
const INTERVIEW_KEYS = [
  'interview','phone screen','technical interview','onsite','gespräch','vorstellungsgespräch','telefoninterview',
  'mülakat','görüşme','schedule a call','book a call','calendly'
];

type Status = 'Applied' | 'Phone Screen' | 'Interview' | 'Offer' | 'Rejected' | 'Withdrawn';
const STATUS_WEIGHT: Record<Status, number> = { Applied:1, 'Phone Screen':2, Interview:3, Offer:4, Rejected:5, Withdrawn:6 };
const promote = (prev?: Status, incoming?: Status): Status =>
  (!prev ? (incoming || 'Applied') : (!incoming ? prev : (STATUS_WEIGHT[incoming] >= STATUS_WEIGHT[prev] ? incoming : prev)));

/* ===== eşleştirme (normalized) ===== */
function subjectRoot(s: string) {
  const x = s.replace(/\s+\(.+?\)\s*$/,'');
  return x.split(' - ')[0].split(' — ')[0].split(' – ')[0].trim();
}
function escapeSQLLiteral(s: string) { return `'${s.replace(/'/g, "''")}'`; }
function escapeSQLIdent(s: string) { return s.replace(/"/g, '""'); }

async function findExistingApplicationNormalized(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  threadId: string | undefined,
  nCompany?: string,
  nRole?: string,
  subject?: string
) {
  if (threadId) {
    const { data } = await supabase
      .from('job_applications')
      .select('id, status')
      .eq('user_id', userId)
      .eq('thread_id', threadId)
      .limit(1);
    if (data && data[0]) return data[0];
  }

  const since = new Date(Date.now() - 60*24*60*60*1000).toISOString();

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

    if (data && data.length) {
      const cand = data.find(r => {
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
    if (data && data[0]) return data[0];
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

    const { data: tokenRow } = await supabase
      .from('gmail_tokens')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
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
    if (!ids.length) {
      return NextResponse.json({ ok:true, imported:0, scanned:0, skippedBy:{ no_ids_from_gmail:1 }, usedQuery:query });
    }

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
      const gmailLink = `https://mail.google.com/mail/#all/${msg.data.id}`;

      const body = extractBodyText(msg.data.payload);
      const txtAll = toHay(subject, body, from, returnPath, replyTo);

      const fromDom = emailDomain(from);

      // Erken dışlama
      if (fromDom && EXCLUDE_NON_APPLICATION_SENDER_DOMAINS.some(d => fromDom.endsWith(d))) {
        skip('non_application_domain'); continue;
      }
      if (hasAny(txtAll, EXCLUDE_HEALTH_APPT_KEYS))   { skip('health_or_therapy_notice'); continue; }
      if (hasAny(txtAll, EXCLUDE_NEWSLETTER_KEYS))    { skip('newsletter');               continue; }
      if (hasAny(txtAll, EXCLUDE_SERVICE_KEYS))       { skip('service_notice');           continue; }
      if (hasAny(txtAll, EXCLUDE_ALERT_KEYS) || hasAny(txtAll, EXCLUDE_JOB_ADVERT_KEYS)) {
        skip('job_advert_or_alert'); continue;
      }

      // Status sinyali
      const isRejected  = hasAny(txtAll, REJECTION_KEYS);
      const isInterview = hasAny(txtAll, INTERVIEW_KEYS);
      const strong      = hasAny(txtAll, STRONG_POSITIVE);
      const medium      = hasAny(txtAll, MEDIUM_POSITIVE);

      let status: Status | undefined;
      if (isRejected) status = 'Rejected';
      else if (isInterview) status = 'Interview';
      else if (strong || medium) status = 'Applied';

      const senderBlob = `${from} ${returnPath} ${replyTo}`.toLowerCase();
      let source = Object.entries(SOURCE_BY_DOMAIN).find(([d]) => fromDom.endsWith(d))?.[1] ?? 'Other';
      const isKnownATS = Object.keys(SOURCE_BY_DOMAIN).some(dom => senderBlob.includes(dom) || (fromDom && fromDom.endsWith(dom)));
      if (!status && isKnownATS) status = 'Applied';
      if (!status) { skip('no_positive_signal'); continue; }

      // --- Company = Subject at Sender DisplayName ---
      const dispNameRaw = (() => {
        const m = (from.match(/^"?(.*?)"?\s*<[^>]+>/) || from.match(/^([^<@]+)@/));
        const dn = m ? m[1].trim() : '';
        return dn || '';
      })();
      const companyField = (() => {
        const subj = (subject || '').trim();
        const dn = (dispNameRaw || '').trim();
        if (subj && dn) return `${subj} at ${dn}`;
        return subj || dn || '(Unknown)';
      })();

      // --- Role & jobUrl (gövde ağırlıklı) ---
      const rc = extractRoleFromBody(subject, body, source);
      const nRole = normalizeRole(rc.role) || '(Unknown)';
      const jobUrl = rc.jobUrl || null;

      const apply_date = dateStr ? new Date(dateStr).toISOString().slice(0,10) : null;

      // Eşleştirme & Upsert
      let applicationId: number | null = null;
      let prevStatus: Status | undefined;

      const existing = await findExistingApplicationNormalized(
        supabase, user.id, threadId,
        companyField !== '(Unknown)' ? companyField : undefined,
        nRole !== '(Unknown)' ? nRole : undefined,
        subject
      );
      if (existing) {
        applicationId = (existing as any).id as number;
        prevStatus = (existing as any).status as Status;
      }

      const finalStatus = promote(prevStatus, status);

      if (applicationId == null) {
        const ins = await supabase.from('job_applications').insert({
          user_id: user.id,
          gmail_id: msg.data.id,
          thread_id: threadId,
          company: companyField,            // <— Subject at Sender
          role: nRole,
          source,
          status: finalStatus,
          apply_date,
          notes: `Imported from Gmail: ${subject}`,
          job_url: jobUrl
        }).select('id').single();
        if (ins.error) { skip(`insert_error_${ins.error.code || 'unknown'}`); continue; }
        applicationId = ins.data.id as number; imported++;
      } else {
        const updPayload: any = {
          status: finalStatus,
          apply_date,
          updated_at: new Date().toISOString(),
        };
        if (companyField && companyField !== '(Unknown)') updPayload.company = companyField;
        if (nRole && nRole !== '(Unknown)') updPayload.role = nRole;
        if (jobUrl) updPayload.job_url = jobUrl;

        const upd = await supabase.from('job_applications').update(updPayload).eq('id', applicationId);
        if (upd.error) { skip(`update_error_${upd.error.code || 'unknown'}`); continue; }
      }

      await supabase.from('job_application_emails').insert({
        user_id: user.id,
        application_id: applicationId!,
        gmail_id: msg.data.id,
        subject,
        sent_at: dateStr ? new Date(dateStr).toISOString() : null,
        gmail_link: gmailLink
      });
    }

    return NextResponse.json({
      ok:true,
      imported,
      scanned: Math.min(ids.length, MAX_TO_FETCH),
      skippedBy,
      usedQuery: query
    });
  } catch (e: any) {
    return NextResponse.json({ ok:false, error: e?.message || String(e) }, { status:500 });
  }
}
