import React, { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { RotateCw, AlertCircle } from 'lucide-react';

GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfPageCanvasProps {
  pdfPath: string;
  pageNumber: number;
}

/**
 * Renders one page of a local PDF (served via /api/files/view-file) to fill its parent container.
 */
export const PdfPageCanvas: React.FC<PdfPageCanvasProps> = ({ pdfPath, pageNumber }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  // Load the document whenever the path changes
  useEffect(() => {
    if (!pdfPath) {
      setDoc(null);
      setStatus('idle');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    // Cache-bust so a re-uploaded file with the same name is reloaded
    const url = `/api/files/view-file?path=${encodeURIComponent(pdfPath)}&t=${Date.now()}`;
    const task = getDocument(url);

    task.promise
      .then(pdf => {
        if (cancelled) return;
        setDoc(pdf);
      })
      .catch(err => {
        if (cancelled) return;
        setDoc(null);
        setStatus('error');
        setErrorMsg(err?.message || 'Failed to load PDF');
      });

    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [pdfPath]);

  // Render the selected page
  useEffect(() => {
    if (!doc || !canvasRef.current) return;

    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    const safePage = Math.min(Math.max(pageNumber, 1), doc.numPages);

    doc.getPage(safePage).then(page => {
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      // Render at ~2x of the displayed width for sharpness
      const baseViewport = page.getViewport({ scale: 1 });
      const targetWidth = Math.max(canvas.clientWidth, 460) * (window.devicePixelRatio || 1) * 1.5;
      const viewport = page.getViewport({ scale: targetWidth / baseViewport.width });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      renderTask = page.render({ canvasContext: ctx, viewport });
      renderTask.promise
        .then(() => !cancelled && setStatus('ready'))
        .catch(err => {
          if (cancelled || err?.name === 'RenderingCancelledException') return;
          setStatus('error');
          setErrorMsg(err?.message || 'Failed to render page');
        });
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, pageNumber]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 w-full h-full pointer-events-none transition-opacity ${
          status === 'ready' ? 'opacity-100' : 'opacity-0'
        }`}
      />
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-slate-500 pointer-events-none">
          <RotateCw className="w-4 h-4 animate-spin" /> Loading PDF preview...
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-6 text-center text-xs text-rose-600 pointer-events-none">
          <AlertCircle className="w-5 h-5" />
          <span className="font-semibold">Could not preview this PDF</span>
          <span className="text-rose-500/80">{errorMsg}</span>
        </div>
      )}
    </>
  );
};
