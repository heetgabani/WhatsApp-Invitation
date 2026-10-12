import React, { useEffect, useState } from 'react';
import { Sidebar, NavTab } from './components/Sidebar';
import { ToastProvider } from './components/Toast';
import { ActiveCampaignBanner } from './components/ActiveCampaignBanner';
import { ContactManagerPage } from './pages/ContactManagerPage';
import { PdfEditorPage } from './pages/PdfEditorPage';
import { WhatsAppPage } from './pages/WhatsAppPage';
import { SendPage } from './pages/SendPage';
import { CampaignHistoryPage } from './pages/CampaignHistoryPage';
import { ProcessedContact, PdfLayoutState } from './types';
import { api } from './services/api';
import { useWhatsAppStatus } from './hooks/useWhatsAppStatus';

const INITIAL_LAYOUT: PdfLayoutState = {
  templatePdfPath: '',
  fontPath: '',
  config: {
    x: 297,
    y: 421,
    size: 26,
    colorHex: '#73141E',
    prefix: 'Dear ',
    suffix: '',
    align: 'center',
    pageNumber: 1,
    fieldName: 'name'
  }
};

export function App() {
  const [currentTab, setCurrentTab] = useState<NavTab>('contacts');
  const [contacts, setContacts] = useState<ProcessedContact[]>([]);
  // One layout (PDF, font, name position) shared by the editor and the send step
  const [pdfLayout, setPdfLayout] = useState<PdfLayoutState>(INITIAL_LAYOUT);
  const whatsapp = useWhatsAppStatus();

  // Default font: Windows' Nirmala UI (English, Gujarati, Hindi), reported by the server if present
  useEffect(() => {
    api.getSettings()
      .then(res => {
        const font = res.settings.system_font_path;
        if (font) setPdfLayout(l => (l.fontPath ? l : { ...l, fontPath: font }));
      })
      .catch(() => {});
  }, []);

  const guests = contacts.filter(c => c.selected && c.isValid);

  return (
    <ToastProvider>
      <div className="flex h-screen bg-slate-50 overflow-hidden font-sans text-slate-900">
        <Sidebar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          done={{
            contacts: guests.length > 0,
            'pdf-editor': Boolean(pdfLayout.templatePdfPath),
            whatsapp: whatsapp?.state === 'connected'
          }}
        />

        <div className="flex-1 flex flex-col h-screen overflow-hidden">
          <ActiveCampaignBanner />

          <main className="flex-1 overflow-y-auto">
            {/* Kept mounted so the uploaded list, edits and the message survive switching steps */}
            <div className={currentTab === 'contacts' ? '' : 'hidden'}>
              <ContactManagerPage onContactsChange={setContacts} onNext={() => setCurrentTab('pdf-editor')} />
            </div>
            {currentTab === 'pdf-editor' && (
              <PdfEditorPage
                layout={pdfLayout}
                onLayoutChange={setPdfLayout}
                guests={guests}
                onNext={() => setCurrentTab('whatsapp')}
              />
            )}
            {currentTab === 'whatsapp' && <WhatsAppPage onNext={() => setCurrentTab('send')} />}
            <div className={currentTab === 'send' ? '' : 'hidden'}>
              <SendPage guests={guests} layout={pdfLayout} whatsapp={whatsapp} onNavigate={setCurrentTab} />
            </div>
            {currentTab === 'history' && <CampaignHistoryPage />}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}

export default App;
