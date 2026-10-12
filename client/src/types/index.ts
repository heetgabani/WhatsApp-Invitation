export interface ProcessedContact {
  index: number;
  name: string;
  phone: string;
  rawPhone: string;
  isValid: boolean;
  validationError?: string;
  isDuplicate: boolean;
  selected: boolean;
  customFields: Record<string, string>;
}

export interface CsvParseResult {
  headers: string[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  contacts: ProcessedContact[];
  suggestedNameColumn?: string;
  suggestedPhoneColumn?: string;
}

export interface PdfOverlayConfig {
  x: number;
  y: number;
  size: number;
  colorHex: string;
  prefix: string;
  suffix?: string;
  align: 'left' | 'center' | 'right';
  pageNumber: number;
  fieldName: string;
  // Optional per-script fonts, used when the guest name is written in that script
  languageFonts?: {
    gujarati?: string;
    devanagari?: string;
  };
}

/** Invitation layout shared between the PDF Editor and the New Campaign wizard */
export interface PdfLayoutState {
  config: PdfOverlayConfig;
  templatePdfPath: string;
  fontPath: string;
}

export interface CampaignRecipient {
  id: string;
  campaign_id: string;
  recipient_index: number;
  phone: string;
  name: string;
  raw_data?: string;
  status: 'queued' | 'sending' | 'accepted' | 'sent' | 'delivered' | 'failed' | 'skipped';
  generated_pdf_path?: string;
  rendered_message?: string;
  whatsapp_message_id?: string;
  error_message?: string;
  retry_count: number;
  interval_ms: number;
  // 1 when the send was interrupted and WhatsApp may already have the message
  send_uncertain?: number;
  sent_at?: string;
  delivered_at?: string;
  read_at?: string;
  created_at: string;
}

export interface Campaign {
  id: string;
  name: string;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
  total_recipients: number;
  completed_count: number;
  failed_count: number;
  current_index: number;
  invitation_pdf_path: string;
  font_path: string;
  output_dir: string;
  pdf_config: string;
  message_template: string;
  min_interval_seconds: number;
  max_interval_seconds: number;
  provider: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  last_error?: string;
  recipients?: CampaignRecipient[];
}

export interface QueueStatus {
  campaignId: string | null;
  state: 'idle' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';
  currentRecipient: {
    index: number;
    name: string;
    phone: string;
    pdfFilename: string;
  } | null;
  totalRecipients: number;
  completedCount: number;
  failedCount: number;
  remainingCount: number;
  progressPercentage: number;
  lastStatus: string | null;
  lastError: string | null;
  nextEligibleProcessingTime: string | null;
  nextDelaySeconds: number | null;
  lastIntervalSeconds: number | null;
  startedAt: string | null;
}

export interface AppSettings {
  default_message: string;
  min_interval_seconds: number;
  max_interval_seconds: number;
  history_retention_days: number;
  cleanup_temp_files: number;
  /** Windows Nirmala UI font path when present; used as the default name font */
  system_font_path?: string;
}

export interface Template {
  id: string;
  name: string;
  type: 'message' | 'pdf_layout';
  content: string;
  created_at: string;
  updated_at: string;
}

export interface LogItem {
  id: number;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  source: 'queue' | 'pdf' | 'csv' | 'whatsapp' | 'system' | 'api';
  message: string;
  details?: string;
}



export type WhatsAppConnectionState =
  | 'idle'
  | 'initializing'
  | 'qr'
  | 'authenticating'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth_failure';

export interface WhatsAppConnectionStatus {
  state: WhatsAppConnectionState;
  qrDataUrl: string | null;
  account: { name: string; phoneMasked: string; platform: string } | null;
  lastConnectedAt: string | null;
  lastError: string | null;
  loadingPercent: number | null;
  reconnectAttempt: number;
  hasSavedSession: boolean;
}
