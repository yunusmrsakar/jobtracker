import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

export async function POST(req: NextRequest) {
  try {
    const cookieStore = cookies();

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value;
          },
          set(name: string, value: string, options: any) {
            cookieStore.set(name, value, options);
          },
          remove(name: string, options: any) {
            cookieStore.set(name, '', { ...options, maxAge: 0 });
          },
        },
      }
    );

    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) {
      return NextResponse.json({ ok: false, error: 'not_auth' }, { status: 401 });
    }

    const access = cookieStore.get('gmail_access_token')?.value;
    const refresh = cookieStore.get('gmail_refresh_token')?.value;
    const expiry = cookieStore.get('gmail_expiry')?.value;

    if (!access) {
      return NextResponse.json({ ok: false, error: 'no_tokens' }, { status: 400 });
    }

    const { error } = await supabase.from('gmail_tokens').upsert(
      {
        user_id: user.id,
        access_token: access,
        refresh_token: refresh ?? null,
        expiry_date: expiry ? new Date(Number(expiry)).toISOString() : null,
      },
      { onConflict: 'user_id' }
    );

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // (İstersen cookie temizliği yapabilirsin)
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
