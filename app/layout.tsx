// app/layout.tsx
import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'JobTracker',
  description: 'Track your job applications in one place.',
};

// app/layout.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr" className="h-full">
      {/* Grammarly vb. yüzünden oluşan attribute farklarını görmezden gel */}
      <body className="min-h-screen bg-gray-50 text-gray-900" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}

