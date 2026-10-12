import {
  AppSettings,
  Template,
  Campaign,
  QueueStatus,
  LogItem,
  CsvParseResult,
  PdfOverlayConfig,
  WhatsAppConnectionStatus
} from '../types';

/** Error carrying the server's JSON body, e.g. code: 'DUPLICATE_CAMPAIGN' */
export class ApiError extends Error {
  constructor(message: string, public status: number, public body: any) {
    super(message);
  }
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {})
    }
  });

  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(data.error || data.message || `Request failed with HTTP ${res.status}`, res.status, data);
  }
  return data;
}

export const api = {
  // Settings
  getSettings: () => fetchJson<{ success: boolean; settings: AppSettings }>('/api/settings'),
  updateSettings: (settings: Partial<AppSettings>) =>
    fetchJson<{ success: boolean; message: string }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settings)
    }),

  // Templates
  listTemplates: (type?: string) =>
    fetchJson<{ success: boolean; templates: Template[] }>(`/api/settings/templates${type ? '?type=' + type : ''}`),
  saveTemplate: (data: { id?: string; name: string; type: string; content: any }) =>
    fetchJson<{ success: boolean; templateId: string }>('/api/settings/templates', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  deleteTemplate: (id: string) =>
    fetchJson<{ success: boolean }>(`/api/settings/templates/${id}`, { method: 'DELETE' }),

  // Files & Native Windows Pickers
  pickFile: (title?: string, filter?: string) =>
    fetchJson<{ selectedPath: string | null; error?: string }>('/api/files/pick-file', {
      method: 'POST',
      body: JSON.stringify({ title, filter })
    }),
  pickFolder: (title?: string) =>
    fetchJson<{ selectedPath: string | null; error?: string }>('/api/files/pick-folder', {
      method: 'POST',
      body: JSON.stringify({ title })
    }),
  validatePath: (targetPath: string, isDirectory = false, allowedExtensions?: string[]) =>
    fetchJson<{ valid: boolean; normalizedPath: string; error?: string; sizeBytes?: number }>(
      '/api/files/validate-path',
      {
        method: 'POST',
        body: JSON.stringify({ targetPath, isDirectory, allowedExtensions })
      }
    ),
  getAssetFiles: () =>
    fetchJson<{
      invitations: any[];
      fonts: any[];
      languages: any[];
      defaultOutputDir: string;
    }>('/api/files/assets'),
  uploadFile: async (file: File, type: 'font' | 'invitation' | 'general' = 'general') => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`/api/files/upload?type=${type}`, {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  },

  // Contacts / CSV
  parseCsvPath: (filePath: string, nameColumn?: string, phoneColumn?: string) =>
    fetchJson<{ success: boolean } & CsvParseResult>('/api/contacts/parse-path', {
      method: 'POST',
      body: JSON.stringify({ filePath, nameColumn, phoneColumn })
    }),
  parseCsvUpload: async (file: File, nameColumn?: string, phoneColumn?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (nameColumn) formData.append('nameColumn', nameColumn);
    if (phoneColumn) formData.append('phoneColumn', phoneColumn);
    const res = await fetch('/api/contacts/parse-upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'CSV upload failed');
    return data as { success: boolean } & CsvParseResult;
  },

  // PDF
  inspectPdf: (pdfPath: string) =>
    fetchJson<{
      success: boolean;
      pageCount: number;
      dimensions: { pageNumber: number; width: number; height: number }[];
      fileSizeBytes: number;
    }>('/api/pdf/inspect', {
      method: 'POST',
      body: JSON.stringify({ pdfPath })
    }),
  validateFont: (fontPath: string) =>
    fetchJson<{
      success: boolean;
      valid: boolean;
      fontFamily?: string;
      indicSupport?: boolean;
      gujaratiSupport?: boolean;
      devanagariSupport?: boolean;
      error?: string;
    }>(
      '/api/pdf/validate-font',
      {
        method: 'POST',
        body: JSON.stringify({ fontPath })
      }
    ),
  generatePreviewPdf: (data: {
    templatePdfPath: string;
    fontPath: string;
    sampleName: string;
    config: PdfOverlayConfig;
    outputDir?: string;
  }) =>
    fetchJson<{ success: boolean; previewPdfPath: string; viewUrl: string }>('/api/pdf/generate-preview', {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  // Campaigns
  listCampaigns: (limit = 50, offset = 0) =>
    fetchJson<{ success: boolean; campaigns: Campaign[] }>(`/api/campaigns?limit=${limit}&offset=${offset}`),
  getCampaign: (id: string) => fetchJson<{ success: boolean; campaign: Campaign }>(`/api/campaigns/${id}`),
  createCampaign: (data: any) =>
    fetchJson<{ success: boolean; id: string; samplePdfPath: string; totalRecipients: number }>('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  deleteCampaign: (id: string) => fetchJson<{ success: boolean }>(`/api/campaigns/${id}`, { method: 'DELETE' }),
  retryCampaign: (id: string, includeUncertain = false) =>
    fetchJson<{ success: boolean; count: number; skippedUncertain: number; message: string }>(`/api/campaigns/${id}/retry`, {
      method: 'POST',
      body: JSON.stringify({ includeUncertain })
    }),

  // Queue
  getQueueStatus: () => fetchJson<{ success: boolean; status: QueueStatus }>('/api/queue/status'),
  startQueue: (campaignId: string) =>
    fetchJson<{ success: boolean; message: string }>('/api/queue/start', {
      method: 'POST',
      body: JSON.stringify({ campaignId })
    }),
  pauseQueue: () => fetchJson<{ success: boolean; message: string }>('/api/queue/pause', { method: 'POST' }),
  resumeQueue: () => fetchJson<{ success: boolean; message: string }>('/api/queue/resume', { method: 'POST' }),
  cancelQueue: () => fetchJson<{ success: boolean; message: string }>('/api/queue/cancel', { method: 'POST' }),

  // WhatsApp Web (QR login). Live updates come from the SSE stream at /api/whatsapp/events.
  getWhatsAppStatus: () => fetchJson<{ success: boolean; status: WhatsAppConnectionStatus }>('/api/whatsapp/status'),
  connectWhatsApp: () => fetchJson<{ success: boolean; status: WhatsAppConnectionStatus }>('/api/whatsapp/connect', { method: 'POST' }),
  reconnectWhatsApp: () => fetchJson<{ success: boolean; status: WhatsAppConnectionStatus }>('/api/whatsapp/reconnect', { method: 'POST' }),
  logoutWhatsApp: () =>
    fetchJson<{ success: boolean; status: WhatsAppConnectionStatus }>('/api/whatsapp/logout', {
      method: 'POST',
      body: JSON.stringify({ confirm: true })
    }),
  clearWhatsAppSession: () =>
    fetchJson<{ success: boolean; status: WhatsAppConnectionStatus }>('/api/whatsapp/clear-session', {
      method: 'POST',
      body: JSON.stringify({ confirm: true })
    }),

  // Logs
  getLogs: (filters?: { level?: string; source?: string; search?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (filters?.level) params.append('level', filters.level);
    if (filters?.source) params.append('source', filters.source);
    if (filters?.search) params.append('search', filters.search);
    if (filters?.limit) params.append('limit', String(filters.limit));
    return fetchJson<{ success: boolean; logs: LogItem[] }>(`/api/logs?${params.toString()}`);
  },
  clearLogs: () => fetchJson<{ success: boolean; message: string }>('/api/logs', { method: 'DELETE' })
};

