import { useEffect, useRef, useState } from 'react';
import { FileText, Upload } from 'lucide-react';

export function ContractButton({ id }: { id: number }) {
  const [c, setC] = useState<{ name: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const load = () => fetch(`/api/crm/investors/${id}/contract`, { credentials: 'include' }).then(r => r.json()).then(j => setC(j.contract)).catch(() => {});
  useEffect(() => { if (id) load(); }, [id]);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/crm/investors/${id}/contract/upload-url`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name }) });
      const { uploadUrl } = await r.json();
      const u = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      if (!u.ok) throw new Error('upload failed');
      await load();
    } catch { alert('Contract upload failed'); } finally { setBusy(false); }
  };
  if (!id) return null;
  return (
    <>
      <input ref={ref} type="file" accept=".pdf,.doc,.docx,image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
      {c && (
        <a href={c.url} target="_blank" rel="noreferrer" title={c.name} data-testid="button-view-contract" className="flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">
          <FileText className="h-3.5 w-3.5" /> View Contract
        </a>
      )}
      <button type="button" disabled={busy} data-testid="button-upload-contract" onClick={() => ref.current?.click()} className="flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100">
        <Upload className="h-3.5 w-3.5" /> {busy ? 'Uploading…' : c ? 'Replace' : 'Upload Contract'}
      </button>
    </>
  );
}
