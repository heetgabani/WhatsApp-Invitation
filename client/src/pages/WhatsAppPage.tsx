import React, { useState } from 'react';
import {
  Smartphone,
  QrCode,
  RotateCw,
  LogOut,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plug,
  ShieldAlert,
  WifiOff,
  ArrowRight
} from 'lucide-react';
import { api } from '../services/api';
import { useWhatsAppStatus } from '../hooks/useWhatsAppStatus';
import { WhatsAppConnectionState } from '../types';
import { useToast } from '../components/Toast';

const STATE_LABELS: Record<WhatsAppConnectionState, { label: string; className: string }> = {
  idle: { label: 'Not connected', className: 'bg-slate-100 text-slate-700' },
  initializing: { label: 'Initializing', className: 'bg-blue-100 text-blue-800' },
  qr: { label: 'Waiting for QR scan', className: 'bg-amber-100 text-amber-800' },
  authenticating: { label: 'Authenticating', className: 'bg-blue-100 text-blue-800' },
  connected: { label: 'Connected', className: 'bg-emerald-100 text-emerald-800' },
  disconnected: { label: 'Disconnected', className: 'bg-slate-100 text-slate-700' },
  reconnecting: { label: 'Reconnecting', className: 'bg-amber-100 text-amber-800' },
  auth_failure: { label: 'Authentication failed', className: 'bg-rose-100 text-rose-800' }
};

const BUSY_STATES: WhatsAppConnectionState[] = ['initializing', 'authenticating', 'reconnecting'];

export const WhatsAppPage: React.FC<{ onNext?: () => void }> = ({ onNext }) => {
  const { success, error } = useToast();
  const status = useWhatsAppStatus();
  const [isActing, setIsActing] = useState(false);

  const run = async (action: () => Promise<unknown>, doneTitle?: string) => {
    setIsActing(true);
    try {
      await action();
      if (doneTitle) success(doneTitle);
    } catch (err: any) {
      error('WhatsApp action failed', err.message);
    } finally {
      setIsActing(false);
    }
  };

  const handleLogout = () => {
    if (!window.confirm('Log out of WhatsApp? This unlinks this computer from your phone and deletes the saved session. You will need to scan a new QR code.')) return;
    run(() => api.logoutWhatsApp(), 'Logged out of WhatsApp');
  };

  const handleClearSession = () => {
    if (!window.confirm('Delete the saved WhatsApp session from this computer? Use this if the connection is stuck. You will need to scan a new QR code, and you may want to remove the old entry under Linked Devices on your phone.')) return;
    run(() => api.clearWhatsAppSession(), 'Session cleared');
  };

  const state = status?.state ?? 'idle';
  const badge = STATE_LABELS[state];
  const isBusy = BUSY_STATES.includes(state);
  const canConnect = state === 'idle' || state === 'disconnected' || state === 'auth_failure';

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 animate-in fade-in duration-150">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Smartphone className="w-6 h-6 text-emerald-600" />
          Step 3: Connect WhatsApp
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          Link your own WhatsApp account by scanning a QR code. The login is saved on this computer, so you only scan once.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
        {/* Status & controls */}
        <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-xs space-y-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Status</span>
            <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1.5 ${badge.className}`}>
              {isBusy && <Loader2 className="w-3 h-3 animate-spin" />}
              {state === 'connected' && <CheckCircle2 className="w-3 h-3" />}
              {badge.label}
            </span>
          </div>

          {status === null ? (
            <div className="space-y-2">
              <div className="h-4 bg-slate-100 rounded animate-pulse" />
              <div className="h-4 bg-slate-100 rounded animate-pulse w-2/3" />
            </div>
          ) : (
            <dl className="text-xs space-y-2.5">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Account</dt>
                <dd className="font-semibold text-slate-900 text-right">
                  {status.account ? `${status.account.name} (${status.account.phoneMasked})` : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Last connected</dt>
                <dd className="text-slate-800 text-right">
                  {status.lastConnectedAt ? new Date(status.lastConnectedAt).toLocaleString() : 'Never'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Saved session</dt>
                <dd className="text-slate-800 text-right">{status.hasSavedSession ? 'Yes, reused on restart' : 'None'}</dd>
              </div>
              {state === 'reconnecting' && (
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Reconnection</dt>
                  <dd className="text-amber-700 text-right">Attempt {status.reconnectAttempt} of 3</dd>
                </div>
              )}
            </dl>
          )}

          {status?.lastError && (
            <div className="flex items-start gap-2 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-3 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{status.lastError}</span>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {canConnect && (
              <button
                onClick={() => run(() => api.connectWhatsApp())}
                disabled={isActing}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-xs transition disabled:opacity-50"
              >
                <Plug className="w-3.5 h-3.5" />
                <span>{status?.hasSavedSession ? 'Connect (saved session)' : 'Connect WhatsApp'}</span>
              </button>
            )}
            {!canConnect && (
              <button
                onClick={() => run(() => api.reconnectWhatsApp())}
                disabled={isActing || isBusy}
                className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg transition disabled:opacity-50"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>Reconnect</span>
              </button>
            )}
            {state === 'connected' && (
              <button
                onClick={handleLogout}
                disabled={isActing}
                className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-300 bg-white hover:bg-rose-50 text-slate-700 hover:text-rose-700 text-xs font-semibold rounded-lg transition disabled:opacity-50"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Log out</span>
              </button>
            )}
            {status?.hasSavedSession && (
              <button
                onClick={handleClearSession}
                disabled={isActing}
                className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-300 bg-white hover:bg-rose-50 text-slate-700 hover:text-rose-700 text-xs font-semibold rounded-lg transition disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear session</span>
              </button>
            )}
          </div>
        </div>

        {/* QR / connection panel */}
        <div className="lg:col-span-3 bg-white p-6 rounded-xl border border-slate-200 shadow-xs flex flex-col items-center justify-center text-center min-h-[380px]">
          {state === 'qr' && status?.qrDataUrl ? (
            <div className="space-y-4">
              <img
                src={status.qrDataUrl}
                alt="WhatsApp login QR code"
                className="w-72 h-72 mx-auto rounded-lg border border-slate-200 p-2 bg-white"
              />
              <p className="text-sm text-slate-700 max-w-sm mx-auto leading-relaxed">
                Open WhatsApp on your phone, go to <strong>Linked Devices</strong>, select <strong>Link a Device</strong>, and scan this QR code.
              </p>
              <p className="text-[11px] text-slate-400">The code refreshes automatically every few seconds.</p>
            </div>
          ) : state === 'connected' ? (
            <div className="space-y-3">
              <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto" />
              <p className="font-semibold text-slate-900">WhatsApp is connected and ready to send.</p>
              {onNext && (
                <button
                  onClick={onNext}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg shadow-sm transition"
                >
                  <span>Next: Send Invitations</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>
          ) : isBusy || state === 'qr' ? (
            <div className="space-y-3">
              <Loader2 className="w-12 h-12 text-emerald-600 animate-spin mx-auto" />
              <p className="font-semibold text-slate-900">
                {state === 'authenticating' ? 'Logged in, loading your chats…' : state === 'reconnecting' ? 'Reconnecting…' : 'Starting WhatsApp Web…'}
              </p>
              <p className="text-xs text-slate-500">
                {status?.loadingPercent ? `Loading ${status.loadingPercent}%` : 'This can take up to a minute the first time.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {state === 'auth_failure' ? (
                <ShieldAlert className="w-14 h-14 text-rose-400 mx-auto" />
              ) : state === 'disconnected' ? (
                <WifiOff className="w-14 h-14 text-slate-300 mx-auto" />
              ) : (
                <QrCode className="w-14 h-14 text-slate-300 mx-auto" />
              )}
              <p className="font-semibold text-slate-900">Not connected</p>
              <p className="text-xs text-slate-500 max-w-sm">
                Click <strong>Connect WhatsApp</strong>. A QR code appears here if a scan is needed.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Honest limitations */}
      <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 space-y-1.5">
        <p className="font-semibold flex items-center gap-1.5">
          <ShieldAlert className="w-4 h-4" /> Unofficial WhatsApp Web automation
        </p>
        <p>
          This connection uses whatsapp-web.js, which is not made or supported by WhatsApp. It can stop working when WhatsApp
          updates its web app, and automated sending may break WhatsApp’s terms and lead to your number being restricted or banned.
          Only send invitations to people who expect them, and keep the default 20–30 second spacing.
        </p>
      </div>
    </div>
  );
};
