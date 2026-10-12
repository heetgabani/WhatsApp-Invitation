import React, { useState, useEffect } from 'react';
import { Folder, FileText, CheckCircle2, AlertCircle, Upload, HardDrive, RefreshCw } from 'lucide-react';
import { api } from '../services/api';
import { useToast } from './Toast';

interface PathPickerProps {
  label: string;
  value: string;
  onChange: (newPath: string) => void;
  isDirectory?: boolean;
  allowedExtensions?: string[];
  filterDescription?: string;
  helpText?: string;
  assetOptions?: { name: string; fullPath: string }[];
  uploadType?: 'font' | 'invitation' | 'general';
  showBrowse?: boolean;
}

export const PathPicker: React.FC<PathPickerProps> = ({
  label,
  value,
  onChange,
  isDirectory = false,
  allowedExtensions,
  filterDescription = 'Supported files',
  helpText,
  assetOptions = [],
  uploadType = 'general',
  showBrowse = true
}) => {
  const { success, error } = useToast();
  const [isValidating, setIsValidating] = useState(false);
  const [validation, setValidation] = useState<{
    valid: boolean;
    error?: string;
    sizeBytes?: number;
  } | null>(null);
  const [isPicking, setIsPicking] = useState(false);

  // Validate path when value changes
  useEffect(() => {
    if (!value) {
      setValidation(null);
      return;
    }

    let isMounted = true;
    setIsValidating(true);

    api.validatePath(value, isDirectory, allowedExtensions)
      .then(res => {
        if (isMounted) {
          setValidation({
            valid: res.valid,
            error: res.error,
            sizeBytes: res.sizeBytes
          });
          setIsValidating(false);
        }
      })
      .catch(err => {
        if (isMounted) {
          setValidation({ valid: false, error: err.message });
          setIsValidating(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [value, isDirectory, allowedExtensions]);

  // Handle native Windows picker
  const handleNativeBrowse = async () => {
    setIsPicking(true);
    try {
      if (isDirectory) {
        const res = await api.pickFolder(`Select ${label}`);
        if (res.selectedPath) {
          onChange(res.selectedPath);
          success('Directory Selected', res.selectedPath);
        }
      } else {
        const filterStr = allowedExtensions && allowedExtensions.length > 0
          ? `${filterDescription} (*${allowedExtensions.join('; *')})|*${allowedExtensions.join('; *')}|All files (*.*)|*.*`
          : 'All files (*.*)|*.*';

        const res = await api.pickFile(`Select ${label}`, filterStr);
        if (res.selectedPath) {
          onChange(res.selectedPath);
          success('File Selected', res.selectedPath);
        }
      }
    } catch (err: any) {
      error('Selection failed', err.message);
    } finally {
      setIsPicking(false);
    }
  };

  // Handle file upload fallback
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const res = await api.uploadFile(file, uploadType);
      onChange(res.filePath);
      success('File Uploaded', `Saved to ${res.filePath}`);
    } catch (err: any) {
      error('Upload Error', err.message);
    }
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-semibold text-slate-700 tracking-wide uppercase">
          {label}
        </label>
        {validation && (
          <span className="flex items-center gap-1 text-xs">
            {validation.valid ? (
              <span className="text-emerald-600 font-medium flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Valid {validation.sizeBytes ? `(${formatFileSize(validation.sizeBytes)})` : ''}
              </span>
            ) : (
              <span className="text-rose-600 font-medium flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" />
                {validation.error || 'Invalid path'}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={isDirectory ? 'e.g. C:\\WhatsApp-Invites\\Output' : 'e.g. C:\\Path\\to\\file.ext'}
            className={`w-full text-xs font-mono px-3 py-2 border rounded-lg bg-white shadow-sm transition outline-none focus:ring-2 focus:ring-emerald-500/20 ${
              validation
                ? validation.valid
                  ? 'border-emerald-300 focus:border-emerald-500'
                  : 'border-rose-300 focus:border-rose-500 bg-rose-50/20'
                : 'border-slate-300 focus:border-slate-500'
            }`}
          />
        </div>

        {/* Windows Explorer Browse Button */}
        {showBrowse && (
        <button
          type="button"
          onClick={handleNativeBrowse}
          disabled={isPicking}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 active:scale-95 transition shadow-sm disabled:opacity-50 shrink-0"
          title="Open Windows File Explorer"
        >
          {isPicking ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          ) : isDirectory ? (
            <Folder className="w-3.5 h-3.5 text-amber-400" />
          ) : (
            <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
          )}
          <span>Browse...</span>
        </button>
        )}

        {/* Upload Fallback (for non-directory) */}
        {!isDirectory && (
          <label className="inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium border border-slate-300 bg-white text-slate-700 rounded-lg hover:bg-slate-50 active:scale-95 transition cursor-pointer shrink-0">
            <Upload className="w-3.5 h-3.5 text-slate-500" />
            <input
              type="file"
              className="hidden"
              accept={allowedExtensions?.join(',')}
              onChange={handleFileUpload}
            />
          </label>
        )}
      </div>

      {/* Asset options helper if available */}
      {assetOptions.length > 0 && (
        <div className="flex items-center gap-1.5 pt-1 text-[11px] text-slate-500 overflow-x-auto pb-1">
          <span className="font-medium text-slate-600 shrink-0">Preset files:</span>
          {assetOptions.map(opt => (
            <button
              key={opt.name}
              type="button"
              onClick={() => onChange(opt.fullPath)}
              className={`px-2 py-0.5 rounded border text-[11px] font-mono transition shrink-0 ${
                value === opt.fullPath
                  ? 'bg-emerald-100 border-emerald-300 text-emerald-800 font-semibold'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
              }`}
            >
              {opt.name}
            </button>
          ))}
        </div>
      )}

      {helpText && <p className="text-[11px] text-slate-500 leading-tight">{helpText}</p>}
    </div>
  );
};

