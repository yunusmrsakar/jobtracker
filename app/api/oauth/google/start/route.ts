// app/api/oauth/google/start/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getOAuthClient, GMAIL_SCOPE, REDIRECT_URI } from '@/lib/google';

export async function GET(req: NextRequest) {
  // Dashboard connectGmail() b parametresi ile token gönderiyor; header'dan da almayı deneriz
  const bearer =
    req.nextUrl.searchParams.get('b') ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

  const oauth2 = getOAuthClient();
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPE,
    redirect_uri: REDIRECT_URI,
    // Supabase bearer token'ı güvenli şekilde state içine koy
    state: JSON.stringify({ b: bearer || null }),
  });

  // Direkt yönlendir
  return NextResponse.redirect(url);

  // Debug istersen:
  // return NextResponse.json({ authUrl: url, usingRedirectUri: REDIRECT_URI });
}
