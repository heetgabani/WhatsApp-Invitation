import React, { useState, useEffect, useRef } from 'react';
import {
  FileEdit,
  Eye,
  Type,
  Palette,
  Sliders,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Download,
  Save,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  ExternalLink,
  Layers,
  RotateCw,
  ArrowRight
} from 'lucide-react';
import { api } from '../services/api';
import { PdfOverlayConfig, PdfLayoutState, Template, ProcessedContact } from '../types';
import { PathPicker } from '../components/PathPicker';
import { PdfPageCanvas } from '../components/PdfPageCanvas';
import { useToast } from '../components/Toast';

interface PdfEditorPageProps {
  layout: PdfLayoutState;
  onLayoutChange: React.Dispatch<React.SetStateAction<PdfLayoutState>>;
  /** Guests selected in step 1; their names are used for the preview */
  guests: ProcessedContact[];
  onNext: () => void;
}

export const PdfEditorPage: React.FC<PdfEditorPageProps> = ({
  layout,
  onLayoutChange,
  guests,
  onNext
}) => {
  const { success, error, info } = useToast();

  // Paths and overlay config live in App so the New Campaign wizard uses exactly this layout
  const { templatePdfPath, fontPath, config } = layout;
  const setTemplatePdfPath = (templatePdfPath: string) => onLayoutChange(l => ({ ...l, templatePdfPath }));
  const setFontPath = (fontPath: string) => onLayoutChange(l => ({ ...l, fontPath }));
  const setConfig = (update: PdfOverlayConfig | ((c: PdfOverlayConfig) => PdfOverlayConfig)) =>
    onLayoutChange(l => ({ ...l, config: typeof update === 'function' ? update(l.config) : update }));

  // PDF Page Metadata
  const [pdfMeta, setPdfMeta] = useState<{
    pageCount: number;
    dimensions: { pageNumber: number; width: number; height: number }[];
  } | null>(null);

  // Font validation status
  const [fontStatus, setFontStatus] = useState<{
    valid: boolean;
    fontFamily?: string;
    indicSupport?: boolean;
    gujaratiSupport?: boolean;
    devanagariSupport?: boolean;
    error?: string;
  } | null>(null);

  // Preview with a real guest from the uploaded CSV (no built-in sample names)
  const [previewGuestIndex, setPreviewGuestIndex] = useState(0);
  const previewGuest = guests[Math.min(previewGuestIndex, Math.max(guests.length - 1, 0))];
  const customFieldNames = Array.from(new Set(guests.flatMap(g => Object.keys(g.customFields || {}))));
  const previewName = previewGuest
    ? (config.fieldName && config.fieldName !== 'name' && previewGuest.customFields?.[config.fieldName]?.trim()) || previewGuest.name
    : 'Guest Name';
  const setLanguageFont = (script: 'gujarati' | 'devanagari', path: string) =>
    setConfig(c => ({ ...c, languageFonts: { ...c.languageFonts, [script]: path || undefined } }));

  // Generated sample PDF preview
  const [previewResult, setPreviewResult] = useState<{
    filePath: string;
    viewUrl: string;
  } | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  // Saved templates
  const [savedPresets, setSavedPresets] = useState<Template[]>([]);
  const [presetName, setPresetName] = useState('');

  // Inspect PDF dimensions
  const inspectPdf = async (path: string) => {
    if (!path) return;
    try {
      const res = await api.inspectPdf(path);
      setPdfMeta({
        pageCount: res.pageCount,
        dimensions: res.dimensions
      });
      // Ensure pageNumber is within bounds
      if (config.pageNumber > res.pageCount) {
        setConfig(c => ({ ...c, pageNumber: 1 }));
      }
    } catch (err: any) {
      console.warn('PDF inspect failed:', err.message);
    }
  };

  // Validate Font
  const validateFont = async (path: string) => {
    if (!path) return;
    try {
      const res = await api.validateFont(path);
      setFontStatus(res);
      if (res.valid && res.indicSupport) {
        info('Font Validated', `${res.fontFamily || 'Font'} supports Indic glyphs (Gujarati & Hindi)`);
      } else if (res.valid) {
        error(
          'Limited language support',
          `${res.fontFamily || 'This font'} has no ${[!res.gujaratiSupport && 'Gujarati', !res.devanagariSupport && 'Hindi'].filter(Boolean).join(' or ')} glyphs. Names in that script will fail to generate.`
        );
      }
    } catch (err: any) {
      setFontStatus({ valid: false, error: err.message });
    }
  };

  // Load layout presets
  const loadPresets = async () => {
    try {
      const res = await api.listTemplates('pdf_layout');
      setSavedPresets(res.templates);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    inspectPdf(templatePdfPath);
    validateFont(fontPath);
    loadPresets();
  }, [templatePdfPath, fontPath]);

  // One-click font choices: fonts placed in assets/fonts plus Windows' Nirmala UI
  const [fontOptions, setFontOptions] = useState<{ name: string; fullPath: string }[]>([]);
  useEffect(() => {
    Promise.all([api.getAssetFiles().catch(() => null), api.getSettings().catch(() => null)]).then(([assets, settings]) => {
      const options = (assets?.fonts || [])
        .filter((f: { name: string }) => /\.(ttf|otf)$/i.test(f.name))
        .map((f: { name: string; fullPath: string }) => ({ name: f.name.replace(/\.(ttf|otf)$/i, ''), fullPath: f.fullPath }));
      const systemFont = settings?.settings.system_font_path;
      setFontOptions(systemFont ? [{ name: 'Nirmala UI (Windows)', fullPath: systemFont }, ...options] : options);
    });
  }, []);

  // Generate test sample PDF
  const handleGenerateSample = async () => {
    setIsGenerating(true);
    try {
      const res = await api.generatePreviewPdf({
        templatePdfPath,
        fontPath,
        sampleName: previewName,
        config,
      });

      setPreviewResult({
        filePath: res.previewPdfPath,
        viewUrl: res.viewUrl
      });
      success('Sample PDF Generated', `Rendered for ${previewName}`);
    } catch (err: any) {
      error('PDF Generation Failed', err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  // Save preset to SQLite
  const handleSavePreset = async () => {
    if (!presetName.trim()) {
      error('Preset name required');
      return;
    }
    try {
      await api.saveTemplate({
        name: presetName.trim(),
        type: 'pdf_layout',
        content: config
      });
      success('Preset Saved', `Saved '${presetName}' for reuse`);
      setPresetName('');
      loadPresets();
    } catch (err: any) {
      error('Failed to save preset', err.message);
    }
  };

  // Apply saved preset
  const handleApplyPreset = (preset: Template) => {
    try {
      const parsed = typeof preset.content === 'string' ? JSON.parse(preset.content) : preset.content;
      // Presets store position/style only; keep the current guest-name field and language fonts
      setConfig(c => ({ ...c, ...parsed, fieldName: c.fieldName, languageFonts: c.languageFonts }));
      success('Preset Applied', preset.name);
    } catch (err: any) {
      error('Failed to apply preset', err.message);
    }
  };

  // Current page dimensions
  const currentPageDim = pdfMeta?.dimensions.find(d => d.pageNumber === config.pageNumber) || {
    width: 595,
    height: 842
  };

  // Handle visual click on the preview canvas container to set X, Y
  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickXPercent = (e.clientX - rect.left) / rect.width;
    const clickYPercent = (e.clientY - rect.top) / rect.height;

    // Convert to PDF coordinates (PDF origin (0,0) is bottom-left)
    const targetX = Math.round(clickXPercent * currentPageDim.width);
    const targetY = Math.round((1 - clickYPercent) * currentPageDim.height);

    setConfig(prev => ({
      ...prev,
      x: targetX,
      y: targetY
    }));
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-150">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <FileEdit className="w-6 h-6 text-emerald-600" />
            Step 2: Invitation PDF
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Upload your invitation PDF, then click on the page where each guest's name should be printed.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleGenerateSample}
            disabled={isGenerating || !templatePdfPath}
            className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-semibold rounded-lg shadow-sm transition disabled:opacity-50"
          >
            {isGenerating ? <RotateCw className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
            <span>Test PDF</span>
          </button>
          <button
            onClick={onNext}
            disabled={!templatePdfPath}
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg shadow-sm transition active:scale-95 disabled:opacity-50"
          >
            <span>Next: Connect WhatsApp</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* File Selectors Card */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-xs space-y-4">
        <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-2">
          <Layers className="w-4 h-4 text-emerald-600" />
          Invitation & Font
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <PathPicker
            label="Invitation PDF"
            value={templatePdfPath}
            onChange={val => {
              setTemplatePdfPath(val);
              inspectPdf(val);
            }}
            allowedExtensions={['.pdf']}
            filterDescription="PDF Document"
            uploadType="invitation"
            helpText="Click the upload icon to choose your invitation PDF. Your original file is never changed."
          />

          <PathPicker
            label="Font for the Name (.ttf / .otf)"
            value={fontPath}
            onChange={val => {
              setFontPath(val);
              validateFont(val);
            }}
            allowedExtensions={['.ttf', '.otf']}
            filterDescription="TrueType / OpenType Fonts"
            helpText={
              fontStatus?.valid
                ? `Embedded Font: ${fontStatus.fontFamily || 'Custom Font'} ${
                    fontStatus.indicSupport
                      ? '(Full Gujarati & Hindi Glyph Coverage)'
                      : `(Gujarati: ${fontStatus.gujaratiSupport ? 'yes' : 'NO'}, Hindi: ${fontStatus.devanagariSupport ? 'yes' : 'NO'})`
                  }`
                : 'Defaults to Windows Nirmala UI (English, Gujarati, Hindi). Upload your own .ttf/.otf to change it.'
            }
            uploadType="font"
            assetOptions={fontOptions}
          />
        </div>

        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-slate-600">Optional: separate fonts for Gujarati or Hindi names</summary>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3">
            <PathPicker
              label="Gujarati Font (optional)"
              value={config.languageFonts?.gujarati || ''}
              onChange={val => setLanguageFont('gujarati', val)}
              allowedExtensions={['.ttf', '.otf']}
              filterDescription="Font Files"
              uploadType="font"
              helpText="Used instead of the main font for names written in Gujarati."
              assetOptions={fontOptions}
            />
            <PathPicker
              label="Hindi Font (optional)"
              value={config.languageFonts?.devanagari || ''}
              onChange={val => setLanguageFont('devanagari', val)}
              allowedExtensions={['.ttf', '.otf']}
              filterDescription="Font Files"
              uploadType="font"
              helpText="Used instead of the main font for names written in Devanagari (Hindi)."
              assetOptions={fontOptions}
            />
          </div>
        </details>
      </div>

      {/* Main 2-Column Editor: Controls on Left, Live Canvas on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Controls Column */}
        <div className="lg:col-span-5 bg-white p-6 rounded-xl border border-slate-200 shadow-xs space-y-5">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
              <Sliders className="w-4 h-4 text-emerald-600" />
              Name Formatting & Position
            </h3>
            {pdfMeta && (
              <span className="text-[11px] font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                Page {config.pageNumber}/{pdfMeta.pageCount} ({currentPageDim.width} × {currentPageDim.height}pt)
              </span>
            )}
          </div>

          {/* Preview guest & printed field (from the uploaded CSV) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
                Preview With Guest
              </label>
              <select
                value={previewGuestIndex}
                onChange={e => setPreviewGuestIndex(parseInt(e.target.value) || 0)}
                disabled={guests.length === 0}
                className="w-full text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white outline-none disabled:bg-slate-50"
              >
                {guests.length === 0 && <option value={0}>Upload contacts in step 1</option>}
                {guests.slice(0, 200).map((g, i) => (
                  <option key={`${g.index}-${g.phone}`} value={i}>{g.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
                Name From CSV Column
              </label>
              <select
                value={config.fieldName || 'name'}
                onChange={e => setConfig(c => ({ ...c, fieldName: e.target.value }))}
                className="w-full text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white outline-none"
              >
                <option value="name">Guest name</option>
                {customFieldNames.map(f => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Greeting Prefix */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
                Greeting Prefix
              </label>
              <input
                type="text"
                value={config.prefix}
                onChange={e => setConfig(c => ({ ...c, prefix: e.target.value }))}
                placeholder="e.g. Dear / સ્નેહી શ્રી"
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 font-medium"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
                Suffix (Optional)
              </label>
              <input
                type="text"
                value={config.suffix || ''}
                onChange={e => setConfig(c => ({ ...c, suffix: e.target.value }))}
                placeholder="e.g. & Family"
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              />
            </div>
          </div>

          {/* Font Size & Alignment */}
          <div className="grid grid-cols-2 gap-3 items-center">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                  Font Size ({config.size}pt)
                </label>
              </div>
              <input
                type="range"
                min="12"
                max="72"
                value={config.size}
                onChange={e => setConfig(c => ({ ...c, size: parseInt(e.target.value) || 24 }))}
                className="w-full accent-emerald-600 cursor-pointer"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
                Alignment
              </label>
              <div className="flex items-center border border-slate-300 rounded-lg overflow-hidden p-0.5 bg-slate-50">
                {(['left', 'center', 'right'] as const).map(align => (
                  <button
                    key={align}
                    type="button"
                    onClick={() => setConfig(c => ({ ...c, align }))}
                    className={`flex-1 py-1.5 flex items-center justify-center rounded text-xs transition ${
                      config.align === align
                        ? 'bg-white shadow-xs font-semibold text-emerald-800'
                        : 'text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    {align === 'left' && <AlignLeft className="w-3.5 h-3.5" />}
                    {align === 'center' && <AlignCenter className="w-3.5 h-3.5" />}
                    {align === 'right' && <AlignRight className="w-3.5 h-3.5" />}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Font Color & Page Selection */}
          <div className="grid grid-cols-2 gap-3 items-center">
            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
                Color
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={config.colorHex}
                  onChange={e => setConfig(c => ({ ...c, colorHex: e.target.value }))}
                  className="w-8 h-8 rounded border border-slate-300 cursor-pointer p-0.5 bg-white"
                />
                <input
                  type="text"
                  value={config.colorHex}
                  onChange={e => setConfig(c => ({ ...c, colorHex: e.target.value }))}
                  className="flex-1 text-xs font-mono px-2 py-1.5 border border-slate-300 rounded outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
                Target Page
              </label>
              <select
                value={config.pageNumber}
                onChange={e => setConfig(c => ({ ...c, pageNumber: parseInt(e.target.value) || 1 }))}
                className="w-full text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white outline-none"
              >
                {Array.from({ length: pdfMeta?.pageCount || 1 }).map((_, i) => (
                  <option key={i + 1} value={i + 1}>Page {i + 1}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Coordinate Sliders (X and Y in points) */}
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div>
              <div className="flex items-center justify-between text-xs font-medium text-slate-700 mb-1">
                <span>Horizontal Position (X: {config.x} pt)</span>
                <span className="text-[10px] text-slate-400 font-mono">0 – {currentPageDim.width}</span>
              </div>
              <input
                type="range"
                min="0"
                max={currentPageDim.width}
                value={config.x}
                onChange={e => setConfig(c => ({ ...c, x: parseInt(e.target.value) || 0 }))}
                className="w-full accent-emerald-600 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs font-medium text-slate-700 mb-1">
                <span>Vertical Position (Y: {config.y} pt from bottom)</span>
                <span className="text-[10px] text-slate-400 font-mono">0 – {currentPageDim.height}</span>
              </div>
              <input
                type="range"
                min="0"
                max={currentPageDim.height}
                value={config.y}
                onChange={e => setConfig(c => ({ ...c, y: parseInt(e.target.value) || 0 }))}
                className="w-full accent-emerald-600 cursor-pointer"
              />
            </div>
          </div>

          {/* Save / Apply Presets */}
          <div className="pt-3 border-t border-slate-100 space-y-2">
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide">
              Save / Load Position Preset
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Preset name (e.g. Wedding Top Center)"
                value={presetName}
                onChange={e => setPresetName(e.target.value)}
                className="flex-1 text-xs px-3 py-1.5 border border-slate-300 rounded-lg outline-none"
              />
              <button
                type="button"
                onClick={handleSavePreset}
                className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg transition"
              >
                Save
              </button>
            </div>

            {savedPresets.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {savedPresets.map(preset => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleApplyPreset(preset)}
                    className="text-[11px] px-2 py-0.5 rounded border border-slate-200 bg-slate-50 hover:bg-emerald-50 text-slate-700 hover:text-emerald-800 transition"
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Live Visual Canvas Column */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                  <Eye className="w-4 h-4 text-emerald-600" />
                  Interactive Layout Canvas
                </h3>
                <p className="text-[11px] text-slate-500">
                  Click anywhere on the preview to position the name. Coordinates update automatically.
                </p>
              </div>

              {previewResult && (
                <a
                  href={previewResult.viewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg transition"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Open Rendered PDF</span>
                </a>
              )}
            </div>

            {/* Interactive Canvas Container (Simulating PDF page proportions) */}
            <div
              onClick={handleCanvasClick}
              className="relative mx-auto bg-amber-50/40 border-2 border-dashed border-amber-300 rounded-lg shadow-inner overflow-hidden cursor-crosshair select-none flex items-center justify-center transition"
              style={{
                width: '100%',
                maxWidth: '460px',
                aspectRatio: `${currentPageDim.width} / ${currentPageDim.height}`,
                backgroundColor: '#FAF7F2'
              }}
            >
              {/* Actual uploaded PDF page rendered as the canvas background */}
              {templatePdfPath ? (
                <PdfPageCanvas pdfPath={templatePdfPath} pageNumber={config.pageNumber} />
              ) : (
                <span className="text-xs text-slate-500 px-6 text-center">Upload your invitation PDF above to see it here.</span>
              )}

              {/* Dynamic Overlay Marker & Rendered Guest Name */}
              {(() => {
                // Convert PDF points back to CSS percentage
                const leftPercent = (config.x / currentPageDim.width) * 100;
                // PDF Y is measured from bottom up
                const topPercent = (1 - (config.y / currentPageDim.height)) * 100;

                let transform = '-translate-y-1/2';
                if (config.align === 'center') transform = '-translate-x-1/2 -translate-y-1/2';
                else if (config.align === 'right') transform = '-translate-x-full -translate-y-1/2';

                return (
                  <div
                    className={`absolute pointer-events-none transition-all duration-75 ${transform}`}
                    style={{
                      left: `${leftPercent}%`,
                      top: `${topPercent}%`,
                    }}
                  >
                    {/* Position Pin Icon */}
                    <div className="w-3 h-3 rounded-full bg-emerald-500 border-2 border-white shadow-md mx-auto mb-1 animate-ping" />

                    {/* Styled Text Preview */}
                    <div
                      className="px-2 py-0.5 rounded border border-emerald-500/40 bg-white/90 shadow-sm backdrop-blur-xs whitespace-nowrap"
                      style={{
                        color: config.colorHex,
                        fontSize: `${Math.max(12, Math.round(config.size * 0.65))}px`,
                        fontWeight: 600,
                        textAlign: config.align
                      }}
                    >
                      {config.prefix}{previewName}{config.suffix || ''}
                    </div>

                    <div className="text-[9px] font-mono text-center text-slate-500 bg-white/80 rounded px-1 mt-0.5">
                      X: {config.x}, Y: {config.y}
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="text-center text-xs text-slate-500 pt-1">
              Previewing: <span className="font-semibold text-slate-800">{config.prefix}{previewName}{config.suffix || ''}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

