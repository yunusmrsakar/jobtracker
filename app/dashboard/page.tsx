// app/dashboard/page.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type AppRow = {
  id: string;
  company: string;
  role: string | null;
  job_url: string | null;
  location: string | null;
  source: 'LinkedIn' | 'Company' | 'Indeed' | 'Other' | string;
  status: 'Applied' | 'Phone Screen' | 'Interview' | 'Offer' | 'Rejected' | 'Withdrawn';
  apply_date: string | null;
  notes: string | null;
  gmail_id: string | null;      // <- mail linki için doğrudan buradan alıyoruz
  created_at?: string;
};

const SOURCES = ['LinkedIn', 'Company', 'Indeed', 'Other'] as const;
const STATUSES = ['Applied','Phone Screen','Interview','Offer','Rejected','Withdrawn'] as const;

// Gmail linkini gmail_id'den üret
function gmailLinkFromId(gmailId?: string | null) {
  if (!gmailId) return null;
  // Çoklu Gmail hesabın varsa .env.local → NEXT_PUBLIC_GMAIL_ACCOUNT_INDEX=0/1/2...
  const idx = process.env.NEXT_PUBLIC_GMAIL_ACCOUNT_INDEX || '0';
  return `https://mail.google.com/mail/u/${idx}/#all/${gmailId}`;
}

export default function Dashboard() {
  const [apps, setApps] = useState<AppRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [gmailLinked, setGmailLinked] = useState(false);
  const [busy, setBusy] = useState(false);

  // add form
  const [form, setForm] = useState<Partial<AppRow>>({
    company: '',
    location: '',
    role: '',
    job_url: '',
    source: 'Other',
    status: 'Applied',
    apply_date: new Date().toISOString().slice(0,10),
    notes: '',
  });

  // inline edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<AppRow>>({});

  const sortApps = useMemo(() => {
    return [...apps].sort((a,b) => {
      const ad = a.apply_date || a.created_at || '';
      const bd = b.apply_date || b.created_at || '';
      return bd.localeCompare(ad);
    });
  }, [apps]);

  async function loadData() {
    setLoading(true);
    // gmail_id kolonunu da çekiyoruz
    const { data, error } = await supabase
      .from('job_applications')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      alert(error.message);
    } else {
      setApps((data ?? []) as AppRow[]);
    }
    setLoading(false);
  }

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        location.href = '/auth';
        return;
      }
      await loadData();

      // gmail callback flag (opsiyonel bilgi mesajı)
      const sp = new URLSearchParams(window.location.search);
      if (sp.get('gmail') === 'ok') {
        setGmailLinked(true);
        const url = new URL(window.location.href);
        url.searchParams.delete('gmail');
        window.history.replaceState({}, '', url.toString());
      }
    })();
  }, []);

  async function addApplication(e: React.FormEvent) {
    e.preventDefault();
    if (!form.company) { alert('Company is required.'); return; }

    const { error } = await supabase.from('job_applications').insert({
      company: form.company,
      role: form.role || null,
      job_url: form.job_url || null,
      location: form.location || null,
      source: form.source || 'Other',
      status: form.status || 'Applied',
      apply_date: form.apply_date || null,
      notes: form.notes || null,
    });
    if (error) { alert(error.message); return; }

    setForm({
      company: '',
      location: '',
      role: '',
      job_url: '',
      source: 'Other',
      status: 'Applied',
      apply_date: new Date().toISOString().slice(0,10),
      notes: '',
    });
    loadData();
  }

  async function updateStatus(id: string, status: AppRow['status']) {
    const { error } = await supabase.from('job_applications').update({ status }).eq('id', id);
    if (error) alert(error.message);
    else loadData();
  }

  function startEdit(row: AppRow) {
    setEditingId(row.id);
    setEditForm({
      company: row.company,
      location: row.location ?? '',
      role: row.role ?? '',
      job_url: row.job_url ?? '',
      source: row.source,
      status: row.status,
      apply_date: row.apply_date ?? '',
      notes: row.notes ?? '',
    });
  }
  function cancelEdit() { setEditingId(null); setEditForm({}); }

  async function saveEdit() {
    if (!editingId) return;
    const payload = {
      company: editForm.company ?? null,
      location: editForm.location ?? null,
      role: editForm.role ?? null,
      job_url: editForm.job_url ?? null,
      source: (editForm.source as AppRow['source']) ?? null,
      status: (editForm.status as AppRow['status']) ?? null,
      apply_date: editForm.apply_date ?? null,
      notes: editForm.notes ?? null,
    };
    const { error } = await supabase.from('job_applications').update(payload).eq('id', editingId);
    if (error) { alert(error.message); return; }
    setEditingId(null);
    setEditForm({});
    loadData();
  }

  async function signOut() { await supabase.auth.signOut(); location.href = '/auth'; }
  async function connectGmail() {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) { alert('No active session.'); return; }
    window.location.href = `/api/oauth/google/start?b=${encodeURIComponent(token)}`;
  }
  async function ingestEmails() {
    try {
      setBusy(true);
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) { alert('No active session.'); return; }

      const r = await fetch('/api/gmail/ingest', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'parse_error' }));
      if (j?.ok) {
        alert(`Imported records: ${j.imported}`);
        await loadData();
        setGmailLinked(true);
      } else {
        alert(`Error while importing emails: ${j?.error || 'unknown'}`);
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">JobTracker Dashboard</h1>
        <div className="flex items-center gap-2">
          <button onClick={connectGmail} className="px-3 py-2 bg-green-600 text-white rounded disabled:opacity-60" disabled={busy}>
            Connect Gmail
          </button>
          <button onClick={ingestEmails} className="px-3 py-2 bg-blue-600 text-white rounded disabled:opacity-60" disabled={busy}>
            Import Emails
          </button>
          <button onClick={signOut} className="px-3 py-2 bg-gray-200 rounded">Sign out</button>
        </div>
      </header>

      {gmailLinked && (
        <div className="bg-green-50 border border-green-200 text-green-800 p-3 rounded">
          Gmail is connected. You can click “Import Emails” any time to fetch new messages.
        </div>
      )}

      {/* Add form */}
      <section className="bg-white p-4 rounded shadow">
        <h2 className="font-medium mb-3">New Application</h2>
        <form onSubmit={addApplication} className="grid md:grid-cols-3 gap-3">
          <input className="border p-2 rounded" placeholder="Company *"
            value={form.company || ''} onChange={e=>setForm({...form, company:e.target.value})}/>
          <input className="border p-2 rounded" placeholder="Location"
            value={form.location || ''} onChange={e=>setForm({...form, location:e.target.value})}/>
          <input className="border p-2 rounded" placeholder="Job URL"
            value={form.job_url || ''} onChange={e=>setForm({...form, job_url:e.target.value})}/>
          <input className="border p-2 rounded" placeholder="(Optional) Role"
            value={form.role || ''} onChange={e=>setForm({...form, role:e.target.value})}/>
          <select className="border p-2 rounded" value={form.source}
            onChange={e=>setForm({...form, source:e.target.value as any})}>
            {SOURCES.map(s=> <option key={s}>{s}</option>)}
          </select>
          <select className="border p-2 rounded" value={form.status}
            onChange={e=>setForm({...form, status:e.target.value as any})}>
            {STATUSES.map(s=> <option key={s}>{s}</option>)}
          </select>
          <input type="date" className="border p-2 rounded" value={form.apply_date || ''}
            onChange={e=>setForm({...form, apply_date:e.target.value})}/>
          <textarea className="border p-2 rounded md:col-span-2" placeholder="Notes"
            value={form.notes || ''} onChange={e=>setForm({...form, notes:e.target.value})}/>
          <button className="bg-black text-white rounded px-4 py-2">Add</button>
        </form>
      </section>

      {/* Table */}
      <section className="bg-white p-4 rounded shadow">
        <h2 className="font-medium mb-3">My Applications</h2>
        {loading ? (
          <div>Loading…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border">
              <thead>
                <tr className="bg-gray-100 text-left">
                  <th className="p-2">Company</th>
                  <th className="p-2">Location</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Apply Date</th>
                  <th className="p-2">Source</th>
                  <th className="p-2">Mail</th>
                  <th className="p-2">Notes</th>
                  <th className="p-2">Job</th>
                  <th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortApps.map(a => {
                  const isEditing = editingId === a.id;
                  const mailLink = gmailLinkFromId(a.gmail_id);

                  return (
                    <tr key={a.id} className="border-t align-top">
                      {/* Company */}
                      <td className="p-2">
                        {isEditing ? (
                          <input
                            className="border p-1 rounded w-full"
                            value={editForm.company ?? ''}
                            onChange={e=>setEditForm(f=>({ ...f, company: e.target.value }))}
                          />
                        ) : a.company}
                      </td>

                      {/* Location */}
                      <td className="p-2">
                        {isEditing ? (
                          <input
                            className="border p-1 rounded w-full"
                            value={editForm.location ?? ''}
                            onChange={e=>setEditForm(f=>({ ...f, location: e.target.value }))}
                            placeholder="e.g., Berlin / Remote"
                          />
                        ) : (a.location || '—')}
                      </td>

                      {/* Status */}
                      <td className="p-2">
                        {isEditing ? (
                          <select
                            className="border p-1 rounded"
                            value={editForm.status ?? a.status}
                            onChange={e=>setEditForm(f=>({ ...f, status: e.target.value as AppRow['status'] }))}
                          >
                            {STATUSES.map(s=> <option key={s}>{s}</option>)}
                          </select>
                        ) : (
                          <select
                            className="border p-1 rounded"
                            value={a.status}
                            onChange={(e)=>updateStatus(a.id, e.target.value as AppRow['status'])}
                          >
                            {STATUSES.map(s=> <option key={s}>{s}</option>)}
                          </select>
                        )}
                      </td>

                      {/* Apply date */}
                      <td className="p-2">
                        {isEditing ? (
                          <input
                            type="date"
                            className="border p-1 rounded"
                            value={editForm.apply_date ?? (a.apply_date || '')}
                            onChange={e=>setEditForm(f=>({ ...f, apply_date: e.target.value }))}
                          />
                        ) : (a.apply_date ?? '—')}
                      </td>

                      {/* Source */}
                      <td className="p-2">
                        {isEditing ? (
                          <select
                            className="border p-1 rounded"
                            value={editForm.source ?? a.source}
                            onChange={e=>setEditForm(f=>({ ...f, source: e.target.value as AppRow['source'] }))}
                          >
                            {SOURCES.map(s=> <option key={s}>{s}</option>)}
                          </select>
                        ) : (a.source || '—')}
                      </td>

                      {/* Mail: job_applications.gmail_id */}
                      <td className="p-2">
                        {mailLink ? (
                          <a
                            className="text-blue-600 underline"
                            href={mailLink}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open in Gmail
                          </a>
                        ) : '—'}
                      </td>

                      {/* Notes */}
                      <td className="p-2">
                        {isEditing ? (
                          <textarea
                            className="border p-1 rounded w-56 h-20"
                            value={editForm.notes ?? ''}
                            onChange={e=>setEditForm(f=>({ ...f, notes: e.target.value }))}
                            placeholder="Add notes, follow-ups, next steps…"
                          />
                        ) : (
                          <div className="max-w-xs whitespace-pre-wrap break-words">
                            {a.notes || '—'}
                          </div>
                        )}
                      </td>

                      {/* Job link */}
                      <td className="p-2">
                        {isEditing ? (
                          <input
                            className="border p-1 rounded w-44"
                            value={editForm.job_url ?? (a.job_url || '')}
                            onChange={e=>setEditForm(f=>({ ...f, job_url: e.target.value }))}
                            placeholder="https://…"
                          />
                        ) : (
                          a.job_url ? (
                            <a className="text-blue-600 underline" href={a.job_url} target="_blank" rel="noreferrer">
                              Open job
                            </a>
                          ) : '—'
                        )}
                      </td>

                      {/* Actions */}
                      <td className="p-2 space-x-2">
                        {isEditing ? (
                          <>
                            <button onClick={saveEdit} className="text-sm bg-blue-600 text-white px-3 py-1 rounded">
                              Save
                            </button>
                            <button onClick={cancelEdit} className="text-sm bg-gray-200 px-3 py-1 rounded">
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button onClick={()=>startEdit(a)} className="text-sm bg-gray-200 px-3 py-1 rounded">
                            Edit
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {apps.length === 0 && (
                  <tr><td className="p-2" colSpan={9}>No records yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
