// app/api/gmail/save-tokens/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  // Next.js 16: cookies() artık Promise döndürüyor
  const cookieStore = await cookies();

  // Örnek: OAuth state / code cookie’lerini okuma (varsa)
  const stateFromCookie = cookieStore.get('g_oauth_state')?.value;
  const userId = cookieStore.get('sb-user-id')?.value; // projendeki user id cookie anahtarı farklıysa değiştir

  // Body'den Google token payload al
  const body = await req.json().catch(() => ({}));
  const {
    access_token,
    refresh_token,
    expiry_date,
    token_type = 'Bearer',
    scope,
  } = body || {};

  if (!userId) {
    return NextResponse.json({ ok: false, error: 'no_user' }, { status: 401 });
  }
  if (!access_token) {
    return NextResponse.json({ ok: false, error: 'no_access_token' }, { status: 400 });
  }

  // Supabase client (server-side)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    // Route Handler’da Authorization header’ı yoksa bu global kısmı çıkarabilirsin
  );

  // gmail_tokens tablosuna upsert
  const upsert = await supabase
    .from('gmail_tokens')
    .upsert(
      {
        user_id: userId,
        access_token,
        refresh_token: refresh_token ?? null,
        expiry_date: expiry_date ?? null,
        token_type,
        scope: scope ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
    .select('user_id')
    .maybeSingle();

  if (upsert.error) {
    return NextResponse.json({ ok: false, error: upsert.error.message }, { status: 500 });
  }

  // İsteğe bağlı: state cookie’sini temizle
  // Next 16’da cookies().set / .delete kullanılabilir (await cookies() üzerinden)
  cookieStore.delete('g_oauth_state');

  // İsteğe bağlı: front-end’e “gmail=ok” flag’i ile geri dön
  const res = NextResponse.json({ ok: true });
  // Örn. oturum/flag cookie ayarlamak istersen:
  // res.cookies.set('gmail_linked', '1', { path: '/', httpOnly: false, sameSite: 'Lax' });
  return res;
}
