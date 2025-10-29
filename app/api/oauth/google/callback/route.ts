// app/api/oauth/google/callback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getOAuthClient } from '@/lib/google';

export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get('code');
    const stateRaw = req.nextUrl.searchParams.get('state') || '';
    let bearer = '';
    try {
      const parsed = JSON.parse(stateRaw);
      if (parsed?.b && typeof parsed.b === 'string') bearer = parsed.b;
    } catch {
      // state okunamadıysa sorun değil
    }

    if (!code) {
      return NextResponse.json({ error: 'missing_code' }, { status: 400 });
    }

    // Supabase client – Authorization header ile kullanıcıyı tanıt
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      bearer ? { global: { headers: { Authorization: `Bearer ${bearer}` } } } : {}
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.redirect(new URL('/auth', req.url));
    }

    // Google tokenlarını al
    const oauth2 = getOAuthClient();
    const { tokens } = await oauth2.getToken(code);

    // Tokenları DB'ye yaz
    const { error } = await supabase.from('gmail_tokens').upsert(
      {
        user_id: user.id,
        access_token: tokens.access_token!,
        refresh_token: tokens.refresh_token ?? null,
        expiry_date: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      },
      { onConflict: 'user_id' }
    );
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Başarılı → dashboard
    return NextResponse.redirect(new URL('/dashboard?gmail=ok', req.url));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
