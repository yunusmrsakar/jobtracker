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
  created_at?: string | null;
  gmail_id?: string | null; // varsa link üretmek için
};

type EmailRow = {
  application_id: string;
  gmail_id: string | null;
  gmail_link: string | null;
  subject: string | null;
  sent_at: string | null;
};

const SOURCES = ['LinkedIn', 'Company', 'Indeed', 'Other'] as const;
const STATUSES = ['Applied','Phone Screen','Interview','Offer','Rejected','Withdrawn'] as const;

// Gmail linkini gmail_id'den üretir
function gmailLinkFromId(gmailId?: string | null) {
  if (!gmailId) return null;
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

  // email metadata
  const [emailsByApp, setEmailsByApp] = useState<Record<string, EmailRow[]>>({});
  const latestEmailLink = (id: string) => {
    const row = emailsByApp[id]?.[0];
    if (!row) return null;
    return gmailLinkFromId(row.gmail_id) || row.gmail_link || null;
  };

  // UI states
  const [expandedEmails, setExpandedEmails] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<AppRow>>({});

  // --- NEW: Filters ---
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState<'All' | AppRow['status']>('All');
  const [fSource, setFSource] = useState<'All' | AppRow['source']>('All');
  const [fFrom, setFFrom] = useState<string>(''); // YYYY-MM-DD
  const [fTo, setFTo] = useState<string>('');

  // --- NEW: Multi-select delete ---
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const sortApps = useMemo(() => {
    return [...apps].sort((a,b) => {
      const ad = a.apply_date || a.created_at || '';
      const bd = b.apply_date || b.created_at || '';
      return (bd > ad ? 1 : bd < ad ? -1 : 0);
    });
  }, [apps]);

  // filtered view
  const filteredApps = useMemo(() => {
    const text = q.trim().toLowerCase();
    return sortApps.filter(a => {
      if (fStatus !== 'All' && a.status !== fStatus) return false;
      if (fSource !== 'All' && a.source !== fSource) return false;

      if (fFrom) {
        const d = (a.apply_date || a.created_at || '').slice(0,10);
        if (!d || d < fFrom) return false;
      }
      if (fTo) {
        const d = (a.apply_date || a.created_at || '').slice(0,10);
        if (!d || d > fTo) return false;
      }

      if (text) {
        const blob = `${a.company} ${a.role ?? ''} ${a.notes ?? ''}`.toLowerCase();
        if (!blob.includes(text)) return false;
      }
      return true;
    });
  }, [sortApps, q, fStatus, fSource, fFrom, fTo]);

  const allVisibleSelected = filteredApps.length > 0 && filteredApps.every(a => selected[a.id]);
  const someVisibleSelected = filteredApps.some(a => selected[a.id]);

  async function loadData() {
    setLoading(true);
    const { data, error } = await supabase
      .from('job_applications')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      alert(error.message);
      setLoading(false);
      return;
    }
    const rows = (data ?? []) as AppRow[];
    setApps(rows);
    setLoading(false);
    await loadEmailMeta(rows.map(d => d.id));
  }

  async function loadEmailMeta(appIds: string[]) {
    if (!appIds.length) {
      setEmailsByApp({});
      return;
    }
    const { data, error } = await supabase
      .from('job_application_emails')
      .select('application_id, gmail_id, gmail_link, subject, sent_at')
      .in('application_id', appIds)
      .order('sent_at', { ascending: false });
    if (error) return;
    const map: Record<string, EmailRow[]> = {};
    (data as EmailRow[]).forEach(row => {
      if (!map[row.application_id]) map[row.application_id] = [];
      map[row.application_id].push(row);
    });
    setEmailsByApp(map);
  }

  async function handleGmailCallbackFlag() {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('gmail') === 'ok') {
      setGmailLinked(true);
      const url = new URL(window.location.href);
      url.searchParams.delete('gmail');
      window.history.replaceState({}, '', url.toString());
    }
  }

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        location.href = '/auth';
        return;
      }
      await loadData();
      await handleGmailCallbackFlag();
    })();
  }, []);

  async function addApplication(e: React.FormEvent) {
    e.preventDefault();
    if (!form.company) {
      alert('Company is required.');
      return;
    }
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
  function cancelEdit() {
    setEditingId(null);
    setEditForm({});
  }

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

  async function signOut() {
    await supabase.auth.signOut();
    location.href = '/auth';
  }

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
    } finally {
      setBusy(false);
    }
  }

  // --- NEW: selection helpers ---
  function toggleSelect(id: string) {
    setSelected(prev => ({ ...prev, [id]: !prev[id] }));
  }
  function toggleSelectAllVisible() {
    const next = { ...selected };
    if (allVisibleSelected) {
      filteredApps.forEach(a => { next[a.id] = false; });
    } else {
      filteredApps.forEach(a => { next[a.id] = true; });
    }
    setSelected(next);
  }
  const selectedIds = useMemo(
    () => Object.keys(selected).filter(k => selected[k]),
    [selected]
  );

  // --- NEW: bulk delete (emails first, then applications) ---
  async function deleteSelected() {
    if (!selectedIds.length) {
      alert('No rows selected.');
      return;
    }
    const ok = confirm(`Delete ${selectedIds.length} selected record(s)? This cannot be undone.`);
    if (!ok) return;

    setBusy(true);
    try {
      // 1) delete email logs
      const { error: e1 } = await supabase
        .from('job_application_emails')
        .delete()
        .in('application_id', selectedIds);
      if (e1) {
        // devam edelim ama kullanıcıya söyleyelim
        console.warn('email delete error', e1);
      }

      // 2) delete applications
      const { error: e2 } = await supabase
        .from('job_applications')
        .delete()
        .in('id', selectedIds);
      if (e2) {
        alert(`Delete failed: ${e2.message}`);
        return;
      }

      // clean local selection
      setSelected({});
      await loadData();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">JobTracker Dashboard</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={connectGmail}
            className="px-3 py-2 bg-green-600 text-white rounded disabled:opacity-60"
            disabled={busy}
          >
            Connect Gmail
          </button>
          <button
            onClick={ingestEmails}
            className="px-3 py-2 bg-blue-600 text-white rounded disabled:opacity-60"
            disabled={busy}
          >
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

      {/* NEW: Filters */}
      <section className="bg-white p-4 rounded shadow">
        <h2 className="font-medium mb-3">Filters</h2>
        <div className="grid md:grid-cols-6 gap-3">
          <input
            className="border p-2 rounded md:col-span-2"
            placeholder="Search company / role / notes"
            value={q}
            onChange={e=>setQ(e.target.value)}
          />
          <select
            className="border p-2 rounded"
            value={fStatus}
            onChange={e=>setFStatus(e.target.value as any)}
          >
            <option value="All">All Statuses</option>
            {STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
          <select
            className="border p-2 rounded"
            value={fSource}
            onChange={e=>setFSource(e.target.value as any)}
          >
            <option value="All">All Sources</option>
            {SOURCES.map(s => <option key={s}>{s}</option>)}
          </select>
          <input
            type="date"
            className="border p-2 rounded"
            value={fFrom}
            onChange={e=>setFFrom(e.target.value)}
            placeholder="From"
          />
          <input
            type="date"
            className="border p-2 rounded"
            value={fTo}
            onChange={e=>setFTo(e.target.value)}
            placeholder="To"
          />
        </div>

        {/* NEW: Bulk actions */}
        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={deleteSelected}
            className="px-3 py-2 bg-red-600 text-white rounded disabled:opacity-60"
            disabled={!someVisibleSelected || busy}
            title={!someVisibleSelected ? 'Select rows to enable' : 'Delete selected'}
          >
            Delete Selected
          </button>
          {someVisibleSelected && (
            <span className="text-sm text-gray-600">
              {selectedIds.length} selected
            </span>
          )}
        </div>
      </section>

      {/* Add form */}
      <section className="bg-white p-4 rounded shadow">
        <h2 className="font-medium mb-3">New Application</h2>
        <form onSubmit={addApplication} className="grid md:grid-cols-3 gap-3">
          <input
            className="border p-2 rounded"
            placeholder="Company *"
            value={form.company || ''}
            onChange={e=>setForm({...form, company:e.target.value})}
          />
          <input
            className="border p-2 rounded"
            placeholder="Location"
            value={form.location || ''}
            onChange={e=>setForm({...form, location:e.target.value})}
          />
          <input
            className="border p-2 rounded"
            placeholder="Job URL"
            value={form.job_url || ''}
            onChange={e=>setForm({...form, job_url:e.target.value})}
          />
          <input
            className="border p-2 rounded"
            placeholder="(Optional) Role"
            value={form.role || ''}
            onChange={e=>setForm({...form, role:e.target.value})}
          />
          <select
            className="border p-2 rounded"
            value={form.source}
            onChange={e=>setForm({...form, source:e.target.value as any})}
          >
            {SOURCES.map(s=> <option key={s}>{s}</option>)}
          </select>
          <select
            className="border p-2 rounded"
            value={form.status}
            onChange={e=>setForm({...form, status:e.target.value as any})}
          >
            {STATUSES.map(s=> <option key={s}>{s}</option>)}
          </select>
          <input
            className="border p-2 rounded"
            type="date"
            value={form.apply_date || ''}
            onChange={e=>setForm({...form, apply_date:e.target.value})}
          />
          <textarea
            className="border p-2 rounded md:col-span-2"
            placeholder="Notes"
            value={form.notes || ''}
            onChange={e=>setForm({...form, notes:e.target.value})}
          />
          <button className="bg-black text-white rounded px-4 py-2">Add</button>
        </form>
      </section>

      {/* Table */}
      <section className="bg-white p-4 rounded shadow">
        <h2 className="font-medium mb-3">My Applications</h2>
        {loading ? <div>Loading…</div> : (
          <div className="overflow-x-auto">
            <table className="w-full border">
              <thead>
                <tr className="bg-gray-100 text-left">
                  <th className="p-2 w-10">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      ref={el => {
                        if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected;
                      }}
                      onChange={toggleSelectAllVisible}
                    />
                  </th>
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
                {filteredApps.map(a=> {
                  const isEditing = editingId === a.id;
                  return (
                    <tr key={a.id} className="border-t align-top">
                      {/* select */}
                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={!!selected[a.id]}
                          onChange={() => toggleSelect(a.id)}
                        />
                      </td>

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

                      {/* Mail: latest + history toggle */}
                      <td className="p-2">
                        {latestEmailLink(a.id) ? (
                          <div className="space-y-1">
                            <a
                              className="text-blue-600 underline"
                              href={latestEmailLink(a.id) as string}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open latest
                            </a>
                            <button
                              className="block text-xs text-gray-600 underline"
                              onClick={() =>
                                setExpandedEmails(prev => ({ ...prev, [a.id]: !prev[a.id] }))
                              }
                            >
                              {expandedEmails[a.id] ? 'Hide history' : 'Show history'}
                            </button>
                            {expandedEmails[a.id] && (
                              <ul className="mt-1 max-h-40 overflow-auto pr-1 text-sm">
                                {(emailsByApp[a.id] || []).map((em, idx) => {
                                  const href = gmailLinkFromId(em.gmail_id) || em.gmail_link || '#';
                                  return (
                                    <li key={idx} className="mb-1">
                                      <a
                                        className="text-blue-600 underline"
                                        href={href}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        {em.sent_at?.slice(0,10) || '—'} — {em.subject || 'Email'}
                                      </a>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>
                        ) : (
                          a.gmail_id ? (
                            <a
                              className="text-blue-600 underline"
                              href={gmailLinkFromId(a.gmail_id) as string}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open latest
                            </a>
                          ) : '—'
                        )}
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
                            <button
                              onClick={saveEdit}
                              className="text-sm bg-blue-600 text-white px-3 py-1 rounded"
                            >
                              Save
                            </button>
                            <button
                              onClick={cancelEdit}
                              className="text-sm bg-gray-200 px-3 py-1 rounded"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={()=>startEdit(a)}
                            className="text-sm bg-gray-200 px-3 py-1 rounded"
                          >
                            Edit
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filteredApps.length === 0 && (
                  <tr><td className="p-2" colSpan={10}>No records match your filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
