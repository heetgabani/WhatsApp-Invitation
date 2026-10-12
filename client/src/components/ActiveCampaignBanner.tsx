import React, { useState, useEffect } from 'react';
import { Play, Pause, XCircle, Clock, Send, AlertCircle, FileCheck } from 'lucide-react';
import { api } from '../services/api';
import { QueueStatus } from '../types';
import { useToast } from './Toast';

export const ActiveCampaignBanner: React.FC = () => {
  const { success, warn, error } = useToast();
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);

  // Poll often only while a campaign is active; when idle, check rarely.
  // Pages dispatch 'queue:changed' after starting a campaign so the banner appears immediately.
  useEffect(() => {
    let isMounted = true;
    let timer: number | undefined;

    const checkQueue = async () => {
      window.clearTimeout(timer);
      let active = false;
      try {
        const res = await api.getQueueStatus();
        if (isMounted) {
          setQueue(res.status);
          active = res.status.state === 'running' || res.status.state === 'paused';
        }
      } catch {
        // quiet error on background poll
      }
      if (isMounted) {
        timer = window.setTimeout(checkQueue, active ? 1500 : 15000);
      }
    };

    checkQueue();
    window.addEventListener('queue:changed', checkQueue);

    return () => {
      isMounted = false;
      window.clearTimeout(timer);
      window.removeEventListener('queue:changed', checkQueue);
    };
  }, []);

  if (!queue || queue.state === 'idle' || !queue.campaignId) {
    return null;
  }

  const handlePause = async () => {
    setIsActionLoading(true);
    try {
      const res = await api.pauseQueue();
      warn('Campaign Paused', res.message);
    } catch (err: any) {
      error('Failed to pause', err.message);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleResume = async () => {
    setIsActionLoading(true);
    try {
      const res = await api.resumeQueue();
      success('Campaign Resumed', res.message);
    } catch (err: any) {
      error('Failed to resume', err.message);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!window.confirm('Are you sure you want to cancel the current campaign? Remaining recipients will not be sent.')) {
      return;
    }
    setIsActionLoading(true);
    try {
      const res = await api.cancelQueue();
      warn('Campaign Cancelled', res.message);
    } catch (err: any) {
      error('Failed to cancel', err.message);
    } finally {
      setIsActionLoading(false);
    }
  };

  const isRunning = queue.state === 'running';
  const isPaused = queue.state === 'paused';

  return (
    <div className="bg-slate-900 text-white border-b border-slate-800 shadow-lg px-4 py-3 sticky top-0 z-40 animate-in slide-in-from-top duration-200">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Left: Campaign state & progress */}
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${isRunning ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
            <span className="text-xs font-bold uppercase tracking-wider bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-slate-700">
              {queue.state}
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-semibold text-emerald-400">
                {queue.currentRecipient ? (
                  <>Processing: {queue.currentRecipient.name}</>
                ) : (
                  <>Queue Active</>
                )}
              </span>
              {queue.currentRecipient && (
                <span className="text-xs text-slate-400 truncate hidden sm:inline">
                  • {queue.currentRecipient.phone}
                </span>
              )}
            </div>

            {queue.currentRecipient?.pdfFilename && (
              <div className="flex items-center gap-1.5 text-xs text-slate-400 truncate">
                <FileCheck className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span className="truncate">{queue.currentRecipient.pdfFilename}</span>
              </div>
            )}
          </div>
        </div>

        {/* Center: Progress Bar & Counts */}
        <div className="flex flex-col items-center min-w-[240px]">
          <div className="flex items-center justify-between w-full text-xs font-mono mb-1">
            <span className="text-slate-300">
              {queue.completedCount} / {queue.totalRecipients} sent ({queue.progressPercentage}%)
            </span>
            {queue.failedCount > 0 && (
              <span className="text-rose-400 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                {queue.failedCount} failed
              </span>
            )}
          </div>
          <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700">
            <div
              className="bg-emerald-500 h-full transition-all duration-300 ease-out"
              style={{ width: `${queue.progressPercentage}%` }}
            />
          </div>
          <div className="flex items-center justify-between w-full text-[10px] text-slate-400 mt-1">
            <span>{queue.remainingCount} remaining</span>
            {queue.lastStatus && <span>Last: {queue.lastStatus}</span>}
          </div>
        </div>

        {/* Right: Countdown & Controls */}
        <div className="flex items-center gap-3 shrink-0">
          {queue.nextDelaySeconds !== null && queue.nextDelaySeconds > 0 && queue.nextEligibleProcessingTime && (
            <div
              className="flex items-center gap-1 text-xs text-amber-300 bg-amber-950/60 border border-amber-800/60 px-2.5 py-1 rounded-md font-mono"
              title="Randomized interval chosen for this gap; the next recipient is not processed before this time"
            >
              <Clock className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : ''}`} />
              <span>
                Next at {new Date(queue.nextEligibleProcessingTime).toLocaleTimeString()} (~{queue.nextDelaySeconds}s
                {queue.lastIntervalSeconds ? ` of ${queue.lastIntervalSeconds}s` : ''})
              </span>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            {isRunning ? (
              <button
                onClick={handlePause}
                disabled={isActionLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition active:scale-95 disabled:opacity-50"
              >
                <Pause className="w-3.5 h-3.5" />
                <span>Pause</span>
              </button>
            ) : isPaused ? (
              <button
                onClick={handleResume}
                disabled={isActionLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition active:scale-95 disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Resume</span>
              </button>
            ) : null}

            <button
              onClick={handleCancel}
              disabled={isActionLoading}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-slate-800 hover:bg-rose-950 text-slate-300 hover:text-rose-300 border border-slate-700 hover:border-rose-800 rounded-lg transition active:scale-95 disabled:opacity-50"
              title="Cancel Campaign"
            >
              <XCircle className="w-3.5 h-3.5" />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

