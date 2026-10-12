import React, { useState, useEffect } from 'react';
import {
  History,
  FileSpreadsheet,
  Download,
  RotateCw,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  FileText,
  ExternalLink,
  RefreshCw,
  Filter,
  Play
} from 'lucide-react';
import { api } from '../services/api';
import { Campaign, CampaignRecipient } from '../types';
import { useToast } from '../components/Toast';

export const CampaignHistoryPage: React.FC = () => {
  const { success, error, warn } = useToast();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  // Filter
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const loadCampaigns = async () => {
    setIsLoading(true);
    try {
      const res = await api.listCampaigns();
      setCampaigns(res.campaigns);
    } catch (err: any) {
      error('Failed to load campaigns', err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadCampaigns();
  }, []);

  const handleSelectCampaign = async (campaignId: string) => {
    setIsDetailLoading(true);
    try {
      const res = await api.getCampaign(campaignId);
      setSelectedCampaign(res.campaign);
    } catch (err: any) {
      error('Failed to load campaign details', err.message);
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleStart = async (campaignId: string) => {
    try {
      const res = await api.startQueue(campaignId);
      success('Campaign Started', res.message);
      handleSelectCampaign(campaignId);
      loadCampaigns();
    } catch (err: any) {
      error('Could not start campaign', err.message);
    }
  };

  const handleRetryFailed = async (campaignId: string) => {
    setIsRetrying(true);
    try {
      let res = await api.retryCampaign(campaignId);
      // Interrupted sends may already be on the guest's phone; resend only after explicit confirmation
      if (res.skippedUncertain > 0 && window.confirm(
        `${res.skippedUncertain} guest(s) were interrupted while sending and may already have received the invitation.\n\n` +
        'Check WhatsApp first. Resend to them anyway?'
      )) {
        res = await api.retryCampaign(campaignId, true);
      }
      if (res.success) {
        success('Retry Queued', res.message);
        handleSelectCampaign(campaignId);
        loadCampaigns();
      } else {
        warn('Retry Notice', res.message);
      }
    } catch (err: any) {
      error('Retry Error', err.message);
    } finally {
      setIsRetrying(false);
    }
  };

  const handleDelete = async (campaignId: string) => {
    if (!window.confirm('Are you sure you want to delete this campaign and its history?')) {
      return;
    }
    try {
      await api.deleteCampaign(campaignId);
      success('Campaign Deleted', 'Removed from local database');
      if (selectedCampaign?.id === campaignId) setSelectedCampaign(null);
      loadCampaigns();
    } catch (err: any) {
      error('Failed to delete', err.message);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Completed</span>;
      case 'running':
        return <span className="bg-blue-100 text-blue-800 text-[11px] font-semibold px-2 py-0.5 rounded-full animate-pulse">Running</span>;
      case 'paused':
        return <span className="bg-amber-100 text-amber-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Paused</span>;
      case 'cancelled':
        return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">Cancelled</span>;
      case 'draft':
        return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">Not Started</span>;
      case 'delivered':
        return <span className="bg-emerald-100 text-emerald-800 text-[10px] font-semibold px-2 py-0.5 rounded-full">Delivered</span>;
      case 'sent':
        return <span className="bg-blue-100 text-blue-800 text-[10px] font-semibold px-2 py-0.5 rounded-full">Sent</span>;
      case 'accepted':
        return (
          <span
            title="WhatsApp accepted the message. Delivery is not confirmed (delivery receipts need a public webhook, which this local app does not expose)."
            className="bg-sky-100 text-sky-800 text-[10px] font-semibold px-2 py-0.5 rounded-full"
          >
            Accepted
          </span>
        );
      case 'sending':
        return <span className="bg-blue-100 text-blue-800 text-[10px] font-semibold px-2 py-0.5 rounded-full animate-pulse">Sending</span>;
      case 'failed':
        return <span className="bg-rose-100 text-rose-800 text-[10px] font-semibold px-2 py-0.5 rounded-full">Failed</span>;
      case 'queued':
        return <span className="bg-slate-100 text-slate-700 text-[10px] font-semibold px-2 py-0.5 rounded-full">Queued</span>;
      default:
        return <span className="bg-slate-100 text-slate-700 text-[10px] font-semibold px-2 py-0.5 rounded-full">{status}</span>;
    }
  };

  const filteredCampaigns = campaigns.filter(c => {
    if (statusFilter === 'all') return true;
    return c.status === statusFilter;
  });

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-150">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <History className="w-6 h-6 text-emerald-600" />
            Campaign History & Delivery Logs
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Review past campaigns, view guest-by-guest delivery statuses, retry failed operations, and export reports.
          </p>
        </div>

        <button
          onClick={loadCampaigns}
          className="inline-flex items-center gap-2 px-3 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg shadow-xs transition"
        >
          <RotateCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Campaigns Table Card */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-4 border-b border-slate-200 bg-slate-50/50 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
            Campaigns ({filteredCampaigns.length})
          </span>

          <div className="flex items-center gap-1 text-xs">
            {['all', 'completed', 'running', 'paused', 'cancelled'].map(tab => (
              <button
                key={tab}
                onClick={() => setStatusFilter(tab)}
                className={`px-2.5 py-1 rounded font-medium capitalize transition ${
                  statusFilter === tab
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {campaigns.length === 0 ? (
          <div className="p-12 text-center text-slate-400">
            <History className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No campaign history recorded yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider">
                <tr>
                  <th className="py-3 px-4">Campaign Name</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Total</th>
                  <th className="py-3 px-4">Sent</th>
                  <th className="py-3 px-4">Failed</th>
                  <th className="py-3 px-4">Created</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {filteredCampaigns.map(c => {
                  const isSelected = selectedCampaign?.id === c.id;

                  return (
                    <tr
                      key={c.id}
                      onClick={() => handleSelectCampaign(c.id)}
                      className={`hover:bg-slate-50/80 cursor-pointer transition ${
                        isSelected ? 'bg-emerald-50/40 font-medium' : ''
                      }`}
                    >
                      <td className="py-3 px-4 font-semibold text-slate-900">{c.name}</td>
                      <td className="py-3 px-4">{getStatusBadge(c.status)}</td>
                      <td className="py-3 px-4 font-mono">{c.total_recipients}</td>
                      <td className="py-3 px-4 font-mono text-emerald-700">{c.completed_count}</td>
                      <td className="py-3 px-4 font-mono text-rose-600">{c.failed_count}</td>
                      <td className="py-3 px-4 text-slate-500">
                        {new Date(c.created_at).toLocaleDateString()}
                      </td>
                      <td className="py-3 px-4 text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-2">
                          <a
                            href={`/api/campaigns/${c.id}/export/csv`}
                            className="p-1 text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 rounded transition"
                            title="Download CSV Report"
                          >
                            <FileSpreadsheet className="w-4 h-4" />
                          </a>
                          <button
                            onClick={() => handleDelete(c.id)}
                            className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition"
                            title="Delete Campaign"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Campaign Details Inspector Card */}
      {selectedCampaign && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-md p-6 space-y-6 animate-in slide-in-from-bottom-2">
          {/* Header & Controls */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-slate-900">{selectedCampaign.name}</h3>
                {getStatusBadge(selectedCampaign.status)}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                ID: <code className="font-mono">{selectedCampaign.id}</code> • Started:{' '}
                {selectedCampaign.started_at
                  ? new Date(selectedCampaign.started_at).toLocaleString()
                  : 'Not started'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {(selectedCampaign.status === 'draft' || selectedCampaign.status === 'paused') && (
                <button
                  onClick={() => handleStart(selectedCampaign.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-xs transition"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>{selectedCampaign.status === 'draft' ? 'Start Sending' : 'Resume'}</span>
                </button>
              )}

              {selectedCampaign.failed_count > 0 && (
                <button
                  onClick={() => handleRetryFailed(selectedCampaign.id)}
                  disabled={isRetrying}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold rounded-lg shadow-xs transition"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                  <span>Retry {selectedCampaign.failed_count} Failed</span>
                </button>
              )}

              <a
                href={`/api/campaigns/${selectedCampaign.id}/export/csv`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg shadow-xs transition"
              >
                <Download className="w-3.5 h-3.5 text-emerald-600" />
                <span>Export CSV Report</span>
              </a>

              <a
                href={`/api/campaigns/${selectedCampaign.id}/export/json`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg shadow-xs transition"
              >
                <Download className="w-3.5 h-3.5 text-blue-600" />
                <span>Export JSON</span>
              </a>
            </div>
          </div>

          {/* Recipient Details Table */}
          <div className="space-y-3">
            <h4 className="font-semibold text-slate-900 text-xs uppercase tracking-wide">
              Recipient Delivery Log ({selectedCampaign.recipients?.length || 0})
            </h4>

            <div className="overflow-x-auto max-h-[400px] border border-slate-200 rounded-lg">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider sticky top-0 z-10">
                  <tr>
                    <th className="py-2.5 px-3 w-10">#</th>
                    <th className="py-2.5 px-3">Guest Name</th>
                    <th className="py-2.5 px-3">Phone</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3">Personalized PDF</th>
                    <th className="py-2.5 px-3">Delay (ms)</th>
                    <th className="py-2.5 px-3">Sent Time</th>
                    <th className="py-2.5 px-3">Details / Errors</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {(selectedCampaign.recipients || []).map((r, i) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-mono text-slate-400">{i + 1}</td>
                      <td className="py-2.5 px-3 font-semibold text-slate-900">{r.name}</td>
                      <td className="py-2.5 px-3 font-mono" title="Phone numbers are masked; the full number is in the exported report">
                        +{r.phone.length > 6 ? `${r.phone.slice(0, 4)}${'*'.repeat(r.phone.length - 6)}${r.phone.slice(-2)}` : r.phone}
                      </td>
                      <td className="py-2.5 px-3">
                        {r.read_at ? (
                          <span className="bg-emerald-600 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full" title={`Read ${new Date(r.read_at).toLocaleString()}`}>
                            Read
                          </span>
                        ) : (
                          getStatusBadge(r.status)
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-[11px] font-mono">
                        {r.generated_pdf_path ? (
                          <a
                            href={`/api/files/view-file?path=${encodeURIComponent(r.generated_pdf_path)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-emerald-700 hover:underline flex items-center gap-1"
                          >
                            <ExternalLink className="w-3 h-3" />
                            <span>{r.generated_pdf_path.split(/[\\/]/).pop()}</span>
                          </a>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px]">
                        {r.interval_ms > 0 ? `${(r.interval_ms / 1000).toFixed(1)}s` : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-slate-500 text-[11px]">
                        {r.sent_at ? new Date(r.sent_at).toLocaleTimeString() : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-slate-500 text-[11px]">
                        {r.error_message ? (
                          <span className="text-rose-600 font-medium">{r.error_message}</span>
                        ) : r.whatsapp_message_id ? (
                          <span className="text-slate-400 font-mono truncate block max-w-xs">{r.whatsapp_message_id}</span>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

