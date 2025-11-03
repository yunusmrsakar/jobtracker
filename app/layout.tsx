// app/layout.tsx
import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'JobTracker',
  description: 'Track your job applications in one place.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr" className="h-full">
      <head>
        {/* Google Search Console doğrulama etiketi */}
        <meta name="google-site-verification" content="TSPGMTTBZ5UHgd7Y36BCuOSn8qr9CnhCPe0CfApIGaI" />
      </head>

      {/* Grammarly vb. yüzünden oluşan attribute farklarını görmezden gel */}
      <body className="min-h-screen bg-gray-50 text-gray-900" suppressHydrationWarning>
        <div className="flex flex-col min-h-screen">
          <main className="flex-1">{children}</main>

          {/* Footer */}
          <footer className="text-center text-xs text-gray-500 mt-12 mb-4">
            © {new Date().getFullYear()} JobTracker •{' '}
            <a
              href="/privacy"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              Privacy Policy
            </a>
          </footer>
        </div>
      </body>
    </html>
  );
}
