import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  MessageSquare,
  Send,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  ExternalLink,
  FileText,
  Phone,
  ShieldCheck,
  Webhook,
} from 'lucide-react';
import type { Investor } from '@workspace/api-client-react';
import { fmtTs } from '@/lib/crm';

const sel =
  'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none';

interface WhatsAppStatusResponse {
  configured: boolean;
  app_id: string;
  phone_number_id: string;
  business_account_id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating: string;
  code_verification_status: string;
  name_status: string;
  webhook_url: string;
  verify_token: string;
  graph_version: string;
  live_connected: boolean;
  error: string | null;
}

interface WhatsAppTemplateComponent {
  type: string;
  format?: string;
  text?: string;
}

interface WhatsAppTemplateItem {
  id: string;
  name: string;
  status: string;
  language: string;
  category: string;
  components?: WhatsAppTemplateComponent[];
}

function normPhoneKey(raw?: string | null): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `1${digits}` : digits;
}

export function WhatsAppPanel({
  rows,
  messages,
  waCardId,
  setWaCardId,
  waPhone,
  setWaPhone,
  workspaceOwner,
  onSendSuccess,
  toast,
}: {
  rows: Investor[];
  messages: any[];
  waCardId: number | '';
  setWaCardId: (v: number | '') => void;
  waPhone: string;
  setWaPhone: (v: string) => void;
  workspaceOwner: string;
  onSendSuccess: () => void;
  toast: any;
}) {
  const [sendMode, setSendMode] = useState<'text' | 'template'>('text');
  const [waText, setWaText] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('hello_world');
  const [selectedLang, setSelectedLang] = useState('en_US');
  const [templateParamsText, setTemplateParamsText] = useState('');
  const [waBusy, setWaBusy] = useState(false);
  const [activeThreadPhone, setActiveThreadPhone] = useState<string>('');
  const [showWebhookConfig, setShowWebhookConfig] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const statusQuery = useQuery<WhatsAppStatusResponse>({
    queryKey: ['/api/crm/whatsapp/status'],
    queryFn: async () => {
      const r = await fetch('/api/crm/whatsapp/status', { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load WhatsApp status');
      return r.json();
    },
  });

  const templatesQuery = useQuery<{ templates: WhatsAppTemplateItem[]; error: string | null }>({
    queryKey: ['/api/crm/whatsapp/templates'],
    queryFn: async () => {
      const r = await fetch('/api/crm/whatsapp/templates', { credentials: 'include' });
      if (!r.ok) return { templates: [], error: 'Could not load templates' };
      return r.json();
    },
  });

  const templates = templatesQuery.data?.templates ?? [];

  const activeTemplateObj = useMemo(() => {
    return templates.find((t) => t.name === selectedTemplate && t.language === selectedLang) ||
      templates.find((t) => t.name === selectedTemplate) ||
      null;
  }, [templates, selectedTemplate, selectedLang]);

  const activeTemplatePreview = useMemo(() => {
    if (!activeTemplateObj?.components) return '';
    const bodyComp = activeTemplateObj.components.find((c) => c.type === 'BODY');
    return bodyComp?.text || '';
  }, [activeTemplateObj]);

  useEffect(() => {
    if (waPhone.trim()) {
      setActiveThreadPhone(normPhoneKey(waPhone));
    }
  }, [waPhone]);

  // Group messages into threads by normalized phone number
  const threads = useMemo(() => {
    const map = new Map<
      string,
      {
        phoneKey: string;
        displayPhone: string;
        firmOrName: string;
        investorId: number | null;
        lastMessage: string;
        lastAt: string;
        unreadOrInbound: number;
        items: any[];
      }
    >();

    for (const m of messages) {
      const key = normPhoneKey(m.phone) || String(m.phone || 'unknown');
      const existing = map.get(key);
      const label = m.firm || m.contact_name || m.phone || 'Unknown';
      if (!existing) {
        map.set(key, {
          phoneKey: key,
          displayPhone: m.phone,
          firmOrName: label,
          investorId: m.investor_id ?? null,
          lastMessage: m.body,
          lastAt: m.created_at,
          unreadOrInbound: m.direction === 'inbound' ? 1 : 0,
          items: [m],
        });
      } else {
        existing.items.push(m);
        existing.lastMessage = m.body;
        existing.lastAt = m.created_at;
        if (!existing.investorId && m.investor_id) existing.investorId = m.investor_id;
        if ((existing.firmOrName === existing.displayPhone || !existing.firmOrName) && (m.firm || m.contact_name)) {
          existing.firmOrName = m.firm || m.contact_name;
        }
        if (m.direction === 'inbound') existing.unreadOrInbound++;
      }
    }

    return Array.from(map.values()).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
  }, [messages]);

  const filteredMessages = useMemo(() => {
    if (!activeThreadPhone) return messages;
    return messages.filter((m) => normPhoneKey(m.phone) === activeThreadPhone);
  }, [messages, activeThreadPhone]);

  const copyValue = (val: string, label: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(val);
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 1800);
      toast({ title: `${label} copied to clipboard` });
    }
  };

  const sendWhatsApp = async (e: React.FormEvent) => {
    e.preventDefault();
    const rawPhone = waPhone.trim();
    if (!rawPhone) {
      toast({ title: 'Enter a recipient WhatsApp phone number', variant: 'destructive' });
      return;
    }

    if (sendMode === 'text' && !waText.trim()) {
      toast({ title: 'Enter a WhatsApp message to send', variant: 'destructive' });
      return;
    }

    setWaBusy(true);
    try {
      const paramsList = templateParamsText
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);

      const payload: Record<string, any> = {
        card_id: waCardId || undefined,
        phone: rawPhone,
        sender: workspaceOwner === 'All' ? 'Guy' : workspaceOwner,
        mode: sendMode,
      };

      if (sendMode === 'template') {
        payload.template_name = selectedTemplate;
        payload.template_language = selectedLang;
        payload.template_params = paramsList;
        payload.template_body_preview = activeTemplatePreview;
      } else {
        payload.body = waText.trim();
      }

      const r = await fetch('/api/crm/whatsapp/send', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(data?.error || 'WhatsApp Cloud API send failed');
      }

      if (sendMode === 'text') setWaText('');
      setActiveThreadPhone(normPhoneKey(rawPhone));
      onSendSuccess();
      toast({
        title:
          sendMode === 'template'
            ? `WhatsApp template "${selectedTemplate}" sent via Meta Cloud API`
            : 'WhatsApp message sent via Meta Cloud API & logged to deal timeline',
      });
    } catch (err: any) {
      onSendSuccess();
      toast({
        title: 'WhatsApp Cloud API Error',
        description: err?.message || 'Could not deliver WhatsApp message',
        variant: 'destructive',
      });
    } finally {
      setWaBusy(false);
    }
  };

  const openWaMeFallback = () => {
    const rawPhone = waPhone.trim();
    const digits = normPhoneKey(rawPhone);
    if (!digits) {
      toast({ title: 'Enter a phone number first', variant: 'destructive' });
      return;
    }
    const text = sendMode === 'text' ? waText.trim() : activeTemplatePreview;
    window.open(
      `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`,
      '_blank',
      'noopener,noreferrer',
    );
  };

  const st = statusQuery.data;

  return (
    <div className="space-y-4">
      {/* Top Meta Cloud API Connection Status Bar */}
      <div className="rounded-xl border border-teal-200 bg-gradient-to-r from-teal-50/80 via-white to-emerald-50/60 p-4 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-600 text-white shadow-xs">
              <MessageSquare className="h-5 w-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-base font-bold text-slate-900">
                  Meta WhatsApp Cloud API
                </h2>
                {st?.live_connected ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800">
                    <CheckCircle2 className="h-3 w-3" /> Connected ({st.quality_rating} Quality)
                  </span>
                ) : statusQuery.isLoading ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600">
                    Checking Meta Graph API...
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">
                    <AlertCircle className="h-3 w-3" /> {st?.error || 'Check Token'}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono-ui text-xs text-slate-600">
                <span className="inline-flex items-center gap-1">
                  <Phone className="h-3 w-3 text-teal-700" />
                  From: <strong className="text-slate-900">{st?.display_phone_number || '+1 555-157-8377'}</strong> ({st?.verified_name || 'Test Number'})
                </span>
                <span>
                  Phone ID: <strong className="text-slate-800">{st?.phone_number_id || '1456028954250856'}</strong>
                </span>
                <span>
                  WABA ID: <strong className="text-slate-800">{st?.business_account_id || '1114165708261816'}</strong>
                </span>
                <span>
                  App ID: <strong className="text-slate-800">{st?.app_id || '4523049234602869'}</strong>
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowWebhookConfig((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Webhook className="h-3.5 w-3.5 text-teal-600" />
              {showWebhookConfig ? 'Hide Webhook Setup' : 'Meta Webhook Config'}
            </button>
            <button
              type="button"
              onClick={() => {
                statusQuery.refetch();
                templatesQuery.refetch();
                onSendSuccess();
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-teal-300 bg-white px-3 py-1.5 text-xs font-semibold text-teal-800 hover:bg-teal-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Sync Meta API
            </button>
          </div>
        </div>

        {showWebhookConfig && (
          <div className="mt-3 grid gap-3 rounded-lg border border-slate-200 bg-white p-3.5 text-xs sm:grid-cols-2">
            <div>
              <div className="mb-1 flex items-center justify-between font-semibold text-slate-700">
                <span>Callback URL (Paste in Meta App → WhatsApp → Configuration)</span>
                <button
                  type="button"
                  onClick={() =>
                    copyValue(st?.webhook_url || 'https://crm.gcs.org/api/whatsapp/webhook', 'Callback URL')
                  }
                  className="inline-flex items-center gap-1 text-teal-700 hover:underline"
                >
                  {copiedField === 'Callback URL' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  Copy
                </button>
              </div>
              <input
                readOnly
                value={st?.webhook_url || 'https://crm.gcs.org/api/whatsapp/webhook'}
                className="w-full rounded border bg-slate-50 px-2.5 py-1.5 font-mono-ui text-xs text-slate-800"
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between font-semibold text-slate-700">
                <span>Verify Token</span>
                <button
                  type="button"
                  onClick={() => copyValue(st?.verify_token || 'gcs_whatsapp_verify_2026', 'Verify Token')}
                  className="inline-flex items-center gap-1 text-teal-700 hover:underline"
                >
                  {copiedField === 'Verify Token' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  Copy
                </button>
              </div>
              <input
                readOnly
                value={st?.verify_token || 'gcs_whatsapp_verify_2026'}
                className="w-full rounded border bg-slate-50 px-2.5 py-1.5 font-mono-ui text-xs text-slate-800"
              />
            </div>
            <div className="sm:col-span-2 flex items-center gap-2 text-[11px] text-slate-500">
              <ShieldCheck className="h-3.5 w-3.5 text-teal-600 shrink-0" />
              <span>
                Subscribe to the <strong>messages</strong> webhook field in Meta Developer Console to stream incoming replies and delivery/read receipts directly into this CRM feed and deal timelines.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Main Two-Column Composer & Thread Feed */}
      <div className="grid gap-6 lg:grid-cols-[1fr_1.45fr]">
        {/* Left: Outbound WhatsApp Cloud API Composer */}
        <form onSubmit={sendWhatsApp} className="rounded-xl border bg-white p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b pb-3">
            <div>
              <h3 className="font-display text-base font-bold text-slate-900">Send WhatsApp Message</h3>
              <p className="text-xs text-slate-500">
                Dispatches directly via Meta Graph API &amp; auto-advances deal stage
              </p>
            </div>
            <div className="inline-flex rounded-lg border bg-slate-100 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setSendMode('text')}
                className={`rounded-md px-2.5 py-1 font-semibold transition ${
                  sendMode === 'text' ? 'bg-white text-teal-800 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Text Message
              </button>
              <button
                type="button"
                onClick={() => setSendMode('template')}
                className={`rounded-md px-2.5 py-1 font-semibold transition ${
                  sendMode === 'template' ? 'bg-white text-teal-800 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Template ({templates.length || 1})
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Select Contact / Deal Card</label>
              <select
                value={waCardId}
                onChange={(e) => {
                  const cid = e.target.value ? Number(e.target.value) : '';
                  setWaCardId(cid);
                  const found = rows.find((r) => r.id === cid);
                  if (found && (found as any).phone) {
                    setWaPhone((found as any).phone);
                  }
                }}
                className={`${sel} w-full`}
              >
                <option value="">-- Select CRM contact (or enter phone below) --</option>
                {rows.slice(0, 250).map((r) => (
                  <option key={r.id} value={r.id}>
                    #{r.id} · {r.firm || r.name} {(r as any).phone ? `(${(r as any).phone})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                Recipient WhatsApp Number (E.164)
              </label>
              <input
                value={waPhone}
                onChange={(e) => setWaPhone(e.target.value)}
                placeholder="+14078021717"
                className={`${sel} w-full font-mono-ui`}
              />
            </div>

            {sendMode === 'template' ? (
              <div className="space-y-3 rounded-lg border border-teal-100 bg-teal-50/40 p-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">Approved Meta Template</label>
                    <select
                      value={selectedTemplate}
                      onChange={(e) => {
                        const name = e.target.value;
                        setSelectedTemplate(name);
                        const match = templates.find((t) => t.name === name);
                        if (match?.language) setSelectedLang(match.language);
                      }}
                      className={`${sel} w-full`}
                    >
                      {templates.length === 0 ? (
                        <option value="hello_world">hello_world (APPROVED)</option>
                      ) : (
                        templates.map((t) => (
                          <option key={`${t.name}-${t.language}`} value={t.name}>
                            {t.name} ({t.status})
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">Language Code</label>
                    <input
                      value={selectedLang}
                      onChange={(e) => setSelectedLang(e.target.value)}
                      placeholder="en_US"
                      className={`${sel} w-full font-mono-ui`}
                    />
                  </div>
                </div>

                {activeTemplatePreview && (
                  <div className="rounded border border-teal-200/80 bg-white p-2.5 text-xs text-slate-700">
                    <div className="mb-1 flex items-center gap-1 font-semibold text-teal-800">
                      <FileText className="h-3.5 w-3.5" /> Template Body Preview
                    </div>
                    <p className="whitespace-pre-wrap text-slate-600">{activeTemplatePreview}</p>
                  </div>
                )}

                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-600">
                    Body Parameters (optional, separate with <code className="font-mono-ui">|</code>)
                  </label>
                  <input
                    value={templateParamsText}
                    onChange={(e) => setTemplateParamsText(e.target.value)}
                    placeholder="e.g. Dr. Chen | EB-2 NIW Opinion Letter"
                    className={`${sel} w-full text-xs`}
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">Message Body</label>
                <textarea
                  rows={4}
                  value={waText}
                  onChange={(e) => setWaText(e.target.value)}
                  placeholder="Hi! Following up on our EB-2 NIW expert opinion letter partnership..."
                  className={`${sel} w-full`}
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Note: For first-time outreach outside a 24h customer reply window, Meta requires an approved template message first.
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="submit"
                disabled={waBusy}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2.5 text-xs font-semibold text-white shadow-xs hover:bg-teal-700 disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                {waBusy
                  ? 'Sending via Meta Cloud API...'
                  : sendMode === 'template'
                    ? `Send "${selectedTemplate}" via Cloud API`
                    : 'Send WhatsApp via Cloud API'}
              </button>
              <button
                type="button"
                onClick={openWaMeFallback}
                title="Open in WhatsApp Desktop / Web (wa.me)"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                <ExternalLink className="h-3.5 w-3.5" /> wa.me
              </button>
            </div>
          </div>
        </form>

        {/* Right: Conversation Threads & Live Message Stream */}
        <div className="rounded-xl border bg-white p-5 shadow-xs flex flex-col">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b pb-3">
            <div>
              <h3 className="font-display text-base font-bold text-slate-900">
                WhatsApp Conversation Threads ({messages.length})
              </h3>
              <p className="text-xs text-slate-500">
                Live outbound &amp; inbound messages with Meta Graph delivery status
              </p>
            </div>
            {activeThreadPhone && (
              <button
                type="button"
                onClick={() => setActiveThreadPhone('')}
                className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Show All Threads ({threads.length})
              </button>
            )}
          </div>

          {threads.length > 0 && (
            <div className="mb-3 flex gap-2 overflow-x-auto pb-1.5">
              <button
                type="button"
                onClick={() => setActiveThreadPhone('')}
                className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                  !activeThreadPhone
                    ? 'border-teal-600 bg-teal-50 text-teal-900'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                All ({messages.length})
              </button>
              {threads.map((th) => {
                const isSelected = activeThreadPhone === th.phoneKey;
                return (
                  <button
                    key={th.phoneKey}
                    type="button"
                    onClick={() => {
                      setActiveThreadPhone(th.phoneKey);
                      setWaPhone(th.displayPhone);
                      if (th.investorId) setWaCardId(th.investorId);
                    }}
                    className={`shrink-0 rounded-lg border px-3 py-1.5 text-left text-xs transition ${
                      isSelected
                        ? 'border-teal-600 bg-teal-50 text-teal-900 font-semibold'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="truncate max-w-[140px]">{th.firmOrName}</span>
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.2 text-[10px] text-slate-600">
                        {th.items.length}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {filteredMessages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center text-xs text-slate-500">
              <MessageSquare className="mb-2 h-7 w-7 text-slate-300" />
              <p className="font-semibold text-slate-700">No WhatsApp messages in this view yet.</p>
              <p className="mt-0.5 text-slate-500">
                Select a contact or enter a number on the left to send a live message or template via Meta Cloud API.
              </p>
            </div>
          ) : (
            <div className="max-h-[460px] space-y-2.5 overflow-y-auto pr-1">
              {filteredMessages.map((w: any) => {
                const isInbound = w.direction === 'inbound';
                const isFailed = w.status === 'failed';
                return (
                  <div
                    key={w.id}
                    className={`rounded-xl border p-3 text-xs ${
                      isFailed
                        ? 'border-red-200 bg-red-50/50'
                        : isInbound
                          ? 'border-blue-200 bg-blue-50/40'
                          : 'border-teal-200/80 bg-teal-50/30'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                            isInbound
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-teal-100 text-teal-800'
                          }`}
                        >
                          {isInbound ? 'Inbound Reply' : 'Outbound'}
                        </span>
                        <span className="font-bold text-slate-900">
                          {w.firm || w.contact_name || w.phone}
                        </span>
                        <span className="font-mono-ui text-slate-500">({w.phone})</span>
                        <span className="text-slate-400">· by {w.sender}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {w.template_name && (
                          <span className="rounded bg-purple-100 px-1.5 py-0.5 font-mono-ui text-[10px] font-semibold text-purple-800">
                            tpl:{w.template_name}
                          </span>
                        )}
                        {w.status && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                              w.status === 'failed'
                                ? 'bg-red-100 text-red-700'
                                : w.status === 'read' || w.status === 'delivered'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {w.status}
                          </span>
                        )}
                        <span className="font-mono-ui">{fmtTs(w.created_at)}</span>
                      </div>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-slate-800">{w.body}</p>
                    {w.error_message && (
                      <p className="mt-1 rounded bg-red-100/80 px-2 py-1 font-mono-ui text-[11px] text-red-700">
                        Meta API Error: {w.error_message}
                      </p>
                    )}
                    {w.wa_message_id && (
                      <div className="mt-1 font-mono-ui text-[10px] text-slate-400">
                        wamid: {w.wa_message_id}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
