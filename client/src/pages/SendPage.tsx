import React, { useEffect, useState } from 'react';
import { Send, CheckCircle2, XCircle, ShieldAlert, RotateCw, Save, MessageSquare, Clock } from 'lucide-react';
import { api, ApiError } from '../services/api';
import { PdfLayoutState, ProcessedContact, Template, WhatsAppConnectionStatus } from '../types';
import { useToast } from '../components/Toast';
import { NavTab } from '../components/Sidebar';

interface SendPageProps {
  guests: ProcessedContact[];
  layout: PdfLayoutState;
  whatsapp: WhatsAppConnectionStatus | null;
  onNavigate: (tab: NavTab) => void;
}

const DEFAULT_MESSAGE =
  'Hello {{name}},\n\nWe are delighted to invite you to our special occasion.\nPlease find your personalized invitation attached.\n\nWe look forward to celebrating with you!';

export const SendPage: React.FC<SendPageProps> = ({ guests, layout, whatsapp, onNavigate }) => {
  const { success, error } = useToast();

  const [campaignName, setCampaignName] = useState(() => `Invitations ${new Date().toLocaleDateString()}`);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [minInterval, setMinInterval] = useState(20);
  const [maxInterval, setMaxInterval] = useState(30);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [isPreparing, setIsPreparing] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [samplePdfUrl, setSamplePdfUrl] = useState<string | null>(null);

  const loadTemplates = () => {
    api.listTemplates('message').then(res => setTemplates(res.templates)).catch(() => {});
  };

  useEffect(() => {
    api.getSettings().then(res => {
      if (res.settings.default_message) setMessage(res.settings.default_message);
      if (res.settings.min_interval_seconds) setMinInterval(res.settings.min_interval_seconds);
      if (res.settings.max_interval_seconds) setMaxInterval(res.settings.max_interval_seconds);
    }).catch(() => {});
    loadTemplates();
  }, []);

  const handleSaveTemplate = async () => {
    if (!templateName.trim()) {
      error('Template name required');
      return;
    }
    try {
      await api.saveTemplate({ name: templateName.trim(), type: 'message', content: message });
      success('Message saved', templateName.trim());
      setTemplateName('');
      loadTemplates();
    } catch (err: any) {
      error('Could not save message', err.message);
    }
  };

  const whatsappReady = whatsapp?.state === 'connected';
  const intervalsValid = minInterval >= 1 && maxInterval >= minInterval;
  const checks = [
    { ok: guests.length > 0, label: guests.length > 0 ? `${guests.length} guests selected` : 'No contacts uploaded', tab: 'contacts' as NavTab },
    { ok: Boolean(layout.templatePdfPath), label: layout.templatePdfPath ? 'Invitation PDF chosen' : 'No invitation PDF', tab: 'pdf-editor' as NavTab },
    {
      ok: whatsappReady,
      label: whatsappReady ? `WhatsApp connected (${whatsapp?.account?.phoneMasked || ''})` : 'WhatsApp not connected',
      tab: 'whatsapp' as NavTab
    }
  ];
  const allReady = checks.every(c => c.ok) && intervalsValid && message.trim().length > 0;

  const previewGuest = guests[0];
  const renderedMessage = message
    .replace(/\{\{name\}\}/gi, previewGuest?.name || 'Guest Name')
    .replace(/\{\{phone\}\}/gi, previewGuest?.phone || '');
  const estimatedMinutes = Math.round((Math.max(guests.length - 1, 0) * (minInterval + maxInterval)) / 2 / 60);

  // Step 1 of launching: render a real sample PDF; a campaign never starts if this fails
  const handleReview = async () => {
    setIsPreparing(true);
    try {
      const res = await api.generatePreviewPdf({
        templatePdfPath: layout.templatePdfPath,
        fontPath: layout.fontPath,
        sampleName: previewGuest.name,
        config: layout.config
      });
      setSamplePdfUrl(res.viewUrl);
      setShowConfirm(true);
    } catch (err: any) {
      error('Test PDF failed, nothing was sent', err.message);
    } finally {
      setIsPreparing(false);
    }
  };

  const handleLaunch = async () => {
    setShowConfirm(false);
    setIsLaunching(true);
    try {
      const payload = {
        name: campaignName.trim(),
        invitationPdfPath: layout.templatePdfPath,
        fontPath: layout.fontPath,
        pdfConfig: layout.config,
        messageTemplate: message,
        minIntervalSeconds: minInterval,
        maxIntervalSeconds: maxInterval,
        contacts: guests
      };

      let created;
      try {
        created = await api.createCampaign(payload);
      } catch (err) {
        // A finished identical campaign may be resent only after explicit confirmation
        const repeatOfCompleted =
          err instanceof ApiError && err.body?.code === 'DUPLICATE_CAMPAIGN' && err.body?.existingStatus === 'completed';
        if (!repeatOfCompleted || !window.confirm(`${(err as Error).message}\n\nSend the same invitations again anyway?`)) {
          throw err;
        }
        created = await api.createCampaign({ ...payload, allowDuplicate: true });
      }

      const started = await api.startQueue(created.id);
      window.dispatchEvent(new Event('queue:changed'));
      success('Sending started', `${created.totalRecipients} invitations queued. ${started.message}`);
      onNavigate('history');
    } catch (err: any) {
      error('Could not start sending', err.message);
    } finally {
      setIsLaunching(false);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 animate-in fade-in duration-150">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Send className="w-6 h-6 text-emerald-600" />
          Step 4: Send Invitations
        </h2>
        <p className="text-sm text-slate-500 mt-1">Write your message, check everything is ready, and send.</p>
      </div>

      {/* Readiness checklist */}
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs grid grid-cols-1 md:grid-cols-3 gap-3">
        {checks.map(c => (
          <button
            key={c.label}
            type="button"
            onClick={() => !c.ok && onNavigate(c.tab)}
            className={`flex items-center gap-2 p-3 rounded-lg border text-left text-xs font-semibold transition ${
              c.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900 cursor-default' : 'bg-rose-50 border-rose-200 text-rose-800 hover:bg-rose-100'
            }`}
          >
            {c.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
            <span>{c.label}</span>
            {!c.ok && <span className="ml-auto font-normal underline">Fix</span>}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
        {/* Message composer */}
        <div className="lg:col-span-3 bg-white p-6 rounded-xl border border-slate-200 shadow-xs space-y-4">
          <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-emerald-600" /> Message
          </h3>

          {templates.length > 0 && (
            <select
              value=""
              onChange={e => {
                const t = templates.find(t => t.id === e.target.value);
                if (t) setMessage(t.content);
              }}
              className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white outline-none"
            >
              <option value="">Load a saved message…</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}

          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={8}
            maxLength={1024}
            className="w-full text-sm px-3 py-2.5 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
          />
          <p className="text-[11px] text-slate-500">
            <code className="font-mono bg-slate-100 px-1 rounded">{'{{name}}'}</code> is replaced with each guest's name. Sent as the caption of the PDF.
          </p>

          <div className="flex gap-2">
            <input
              type="text"
              value={templateName}
              onChange={e => setTemplateName(e.target.value)}
              placeholder="Save this message as…"
              className="flex-1 text-xs px-3 py-1.5 border border-slate-300 rounded-lg outline-none"
            />
            <button
              type="button"
              onClick={handleSaveTemplate}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg transition"
            >
              <Save className="w-3.5 h-3.5" /> Save
            </button>
          </div>
        </div>

        {/* Preview & settings */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-[#e5ddd5] p-4 rounded-xl border border-slate-200">
            <p className="text-[11px] font-semibold text-slate-600 mb-2">Preview for {previewGuest?.name || 'a guest'}</p>
            <div className="bg-[#dcf8c6] rounded-lg p-3 shadow-sm text-xs text-slate-800 space-y-2">
              <div className="bg-white/70 rounded px-2 py-1.5 font-mono text-[11px] truncate">
                📄 Invitation_{(previewGuest?.name || 'Guest').replace(/\s+/g, '_')}.pdf
              </div>
              <p className="whitespace-pre-wrap">{renderedMessage}</p>
            </div>
          </div>

          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs space-y-3">
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide">Campaign Name</label>
            <input
              type="text"
              value={campaignName}
              onChange={e => setCampaignName(e.target.value)}
              className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg outline-none"
            />

            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide pt-1 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" /> Gap Between Guests (seconds)
            </label>
            <div className="flex items-center gap-2 text-xs">
              <input
                type="number"
                min={1}
                value={minInterval}
                onChange={e => setMinInterval(parseInt(e.target.value) || 0)}
                className="w-20 px-2 py-1.5 border border-slate-300 rounded-lg outline-none"
              />
              <span>to</span>
              <input
                type="number"
                min={1}
                value={maxInterval}
                onChange={e => setMaxInterval(parseInt(e.target.value) || 0)}
                className="w-20 px-2 py-1.5 border border-slate-300 rounded-lg outline-none"
              />
              <span className="text-slate-500">random each time</span>
            </div>
            {!intervalsValid && <p className="text-[11px] text-rose-600">The minimum must not be larger than the maximum.</p>}
            {guests.length > 1 && <p className="text-[11px] text-slate-500">About {estimatedMinutes} minute(s) for {guests.length} guests.</p>}
          </div>

          <button
            type="button"
            onClick={handleReview}
            disabled={!allReady || isPreparing || isLaunching}
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold rounded-xl shadow-md transition active:scale-95 disabled:opacity-50"
          >
            {isPreparing || isLaunching ? <RotateCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            <span>{isPreparing ? 'Creating test PDF…' : isLaunching ? 'Starting…' : `Review & Send to ${guests.length} guests`}</span>
          </button>
        </div>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <h3 className="font-bold text-slate-900 text-lg">Send {guests.length} invitations?</h3>

            <div className="flex items-start gap-2 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-3 text-xs">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                This sends real WhatsApp messages from <strong>{whatsapp?.account?.name} ({whatsapp?.account?.phoneMasked})</strong> to{' '}
                {guests.length} people, one every {minInterval}–{maxInterval} seconds. Only send to guests who expect this invitation.
              </span>
            </div>

            {samplePdfUrl && (
              <a href={samplePdfUrl} target="_blank" rel="noreferrer" className="block text-xs font-semibold text-emerald-700 hover:underline">
                Open the test PDF for {previewGuest?.name} to check the name position →
              </a>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50 transition"
              >
                Go Back
              </button>
              <button
                type="button"
                onClick={handleLaunch}
                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold shadow-md transition"
              >
                Yes, Send Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
