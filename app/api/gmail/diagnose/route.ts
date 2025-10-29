// app/api/gmail/diagnose/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const toHay = (...p:(string|null|undefined)[]) => p.filter(Boolean).join('\n').toLowerCase();
const hasAny = (t:string, list:string[]) => list.some(k => t.includes(k));
const b64 = (d:string) => { try { return Buffer.from(d.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'); } catch { return ''; } };
const strip = (h:string)=>h.replace(/<script[\s\S]*?<\/script>/gi,' ')
  .replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();

function extractBodyText(payload:any){
  if(!payload) return '';
  const out:string[]=[];
  const walk=(p:any)=>{
    if(!p) return;
    const mt=p.mimeType||'';
    const data=p.body?.data;
    if(data && (mt.startsWith('text/plain')||mt.startsWith('text/html'))){
      const raw=b64(data); out.push(mt.startsWith('text/html')?strip(raw):raw); return;
    }
    if(Array.isArray(p.parts)) p.parts.forEach(walk);
  };
  walk(payload);
  if(!out.length && payload.body?.data){
    const raw=b64(payload.body.data);
    out.push(payload.mimeType?.startsWith('text/html')?strip(raw):raw);
  }
  return out.join('\n').trim();
}

const ATS = ['greenhouse.io','lever.co','personio.de','personio.com','ashbyhq.com','smartrecruiters.com','teamtailor.com','recruitee.com','workable.com','workablemail.com','bamboohr.com','workday.com','join.com','jobvite.com','icims.com','successfactors.com','oraclecloud.com'];

const NL_DOMAINS = ['talent.com','stepstone.de','stepstone.com','indeedemail.com','indeed.com','monster.com','glassdoor.com','zeit.de','newsletter.zeit.de','substack.com','mailchimp.com','sendgrid.net','sparkpostmail.com'];
const NL_KEYS = ['job alert','daily jobs','weekly jobs','neusten treffer','neue treffer','tägliche','benachrichtigung','digest','newsletter','unsubscribe','e-mail-einstellungen','view more jobs','weitere passende jobs','mehr jobs anzeigen','im browser lesen'];

const REJ = ['we will not move forward','not moving forward','will not proceed','decided not to move forward','no longer under consideration','regret to inform you','unfortunately we will not','after careful consideration, we will not','leider können wir','leider müssen wir','absage','nicht weiter','keine berücksichtigung','üzgünüz','olumsuz'];
const INT = ['interview','phone screen','technical interview','onsite','gespräch','vorstellungsgespräch','telefoninterview','mülakat','görüşme'];
const STRONG = ['application received','your application was received','we received your application','thank you for applying','your application to','ihre bewerbung','bewerbung eingegangen','wir haben deine bewerbung erhalten','wir haben ihre bewerbung erhalten','candidature reçue','candidature bien reçue'];
const MED = ['application','applied','bewerbung','postulation','candidature'];

export async function POST(req:NextRequest){
  try{
    const auth = req.headers.get('authorization');
    if(!auth) return NextResponse.json({ok:false,error:'not_auth'},{status:401});

    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{global:{headers:{Authorization:auth}}});
    const {data:{user}} = await supabase.auth.getUser();
    if(!user) return NextResponse.json({ok:false,error:'not_auth'},{status:401});

    const {data:tok} = await supabase.from('gmail_tokens').select('*').eq('user_id',user.id).maybeSingle();
    if(!tok) return NextResponse.json({ok:false,error:'no_gmail_link'},{status:400});

    const oauth = new google.auth.OAuth2();
    oauth.setCredentials({access_token:tok.access_token,refresh_token:tok.refresh_token ?? undefined});
    const gmail = google.gmail({version:'v1',auth:oauth});

    const q = 'newer_than:120d -category:promotions -category:social';
    const list = await gmail.users.messages.list({userId:'me',q,maxResults:30});
    const ids = (list.data.messages ?? []).map(m=>m.id!);

    const rows:any[]=[];
    for(const id of ids){
      const g = await gmail.users.messages.get({userId:'me',id,format:'full'});
      const headers = (g.data.payload?.headers ?? []) as Array<{name:string,value:string}>;
      const getH=(n:string)=>headers.find(h=>h.name?.toLowerCase()===n.toLowerCase())?.value ?? '';
      const subject = getH('Subject');
      const from = getH('From');
      const body = extractBodyText(g.data.payload);
      const txt = toHay(subject,body,from);

      const fromDomain = (/@([^>\s]+)/.exec(from)?.[1] || '').toLowerCase();

      const isATS = ATS.some(d=>from.toLowerCase().includes(d));
      const isNLDomain = NL_DOMAINS.some(d=>fromDomain.endsWith(d));
      const isNLKey = NL_KEYS.some(k=>txt.includes(k));
      const hasListUnsub = headers.some(h=>h.name?.toLowerCase()==='list-unsubscribe');

      const flags = {
        isATS,
        isNewsletterDomain:isNLDomain,
        hasListUnsubscribe:hasListUnsub,
        hasNewsletterKeys:isNLKey,
        isRejected: hasAny(txt,REJ),
        isInterview: hasAny(txt,INT),
        strongPositive: hasAny(txt,STRONG),
        mediumPositive: hasAny(txt,MED),
      };

      rows.push({
        id,
        from,
        subject,
        preview: body.slice(0,160),
        ...flags
      });
    }

    return NextResponse.json({ok:true,rows});
  }catch(e:any){
    return NextResponse.json({ok:false,error:e?.message||String(e)},{status:500});
  }
}
