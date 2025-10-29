// app/privacy/page.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy • JobTracker",
  description:
    "JobTracker privacy policy for Gmail integration and job application tracking.",
  robots: { index: false, follow: false }, // Politikayı arama motorlarına açmak istemezsen
};

export default function PrivacyPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-12 prose prose-slate dark:prose-invert">
      <h1>Privacy Policy – JobTracker</h1>
      <p><em>Last updated: October 2025</em></p>

      <p>
        JobTracker (“we”, “our”, “us”) respects your privacy and is committed to
        protecting your personal data. This app connects to your Google account
        (via OAuth) to read <strong>job-related email metadata</strong>—such as
        subject, sender, and date—so we can automatically track your job
        applications.
      </p>

      <h2>What we access</h2>
      <ul>
        <li>Email <strong>metadata</strong> (subject, sender, date, Gmail ID/thread ID)</li>
        <li>Optionally a job link if it exists in the message body</li>
        <li>We <strong>do not</strong> send email or modify your mailbox</li>
      </ul>

      <h2>How we use the data</h2>
      <ul>
        <li>To create/update your job application records inside JobTracker</li>
        <li>To let you open the original email directly in Gmail via a link</li>
      </ul>

      <h2>Storage & sharing</h2>
      <ul>
        <li>Data is stored in your JobTracker database (Supabase).</li>
        <li>We do <strong>not</strong> sell or share your data with third parties.</li>
      </ul>

      <h2>Revoking access</h2>
      <p>
        You can revoke JobTracker’s Gmail access at any time from your Google
        Account:&nbsp;
        <a
          href="https://myaccount.google.com/permissions"
          target="_blank"
          rel="noreferrer"
        >
          https://myaccount.google.com/permissions
        </a>
        .
      </p>

      <h2>Data deletion</h2>
      <p>
        You may request deletion of your JobTracker data by contacting us at{" "}
        <a href="mailto:yunusmrsakar@gmail.com">yunusmrsakar@gmail.com</a>. You
        can also manually delete your records from within the app.
      </p>

      <h2>Contact</h2>
      <p>
        For any questions about this Privacy Policy, contact:
        {" "}
        <a href="mailto:yunusmrsakar@gmail.com">yunusmrsakar@gmail.com</a>
      </p>

      <hr />

      <h2>Gizlilik Politikası – JobTracker (TR)</h2>
      <p><em>Güncelleme: Ekim 2025</em></p>
      <p>
        JobTracker, Google hesabınıza (OAuth) bağlanarak <strong>iş başvurusu ile
        ilgili e-posta metaverilerini</strong> (konu, gönderen, tarih, Gmail
        kimliği) okur ve başvurularınızı otomatik olarak takip etmenizi sağlar.
        E-posta içeriklerini paylaşmaz veya üçüncü taraflara aktarmaz.
      </p>
      <ul>
        <li>Verileriniz yalnızca JobTracker (Supabase) veritabanınızda saklanır.</li>
        <li>
          İstediğiniz zaman Google hesabınızdan erişimi iptal edebilirsiniz:
          {" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
          >
            https://myaccount.google.com/permissions
          </a>
        </li>
        <li>
          Silme talebi için:{" "}
          <a href="mailto:yunusmrsakar@gmail.com">yunusmrsakar@gmail.com</a>
        </li>
      </ul>
    </main>
  );
}
