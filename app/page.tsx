'use client';

import { supabase } from '@/lib/supabaseClient';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AuthPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace('/dashboard');
      else setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) router.replace('/dashboard');
    });
    return () => sub.subscription.unsubscribe();
  }, [router]);

  if (loading) return <div className="p-6">Yükleniyor…</div>;

  return (
    
    <div className="max-w-md mx-auto p-6">
      
      <h1 className="text-2xl font-semibold mb-4">JobTracker’a hoş geldin</h1>
      <Auth
        supabaseClient={supabase}
        appearance={{ theme: ThemeSupa }}
        providers={[]}
        view="sign_in"
        localization={{
          variables: {
            sign_in: { email_label: 'E-posta', password_label: 'Şifre', button_label: 'Giriş' },
            sign_up: { email_label: 'E-posta', password_label: 'Şifre', button_label: 'Kayıt ol' },
          },
        }}
      />
      <p className="text-xs text-gray-500 mt-6 text-center">
        By using this app you agree to our{' '}
        <a href="/privacy" className="underline" target="_blank" rel="noreferrer">
          Privacy Policy
        </a>.
      </p>
      
    </div>
  );
}


