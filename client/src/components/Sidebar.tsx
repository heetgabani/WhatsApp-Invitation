import React from 'react';
import { Send, Users, FileEdit, History, Smartphone, ShieldCheck, CheckCircle2 } from 'lucide-react';

export type NavTab = 'contacts' | 'pdf-editor' | 'whatsapp' | 'send' | 'history';

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  /** Which steps are complete, to show a check mark */
  done: Partial<Record<NavTab, boolean>>;
}

const STEPS: { id: NavTab; label: string; icon: React.ElementType }[] = [
  { id: 'contacts', label: 'Upload Contacts', icon: Users },
  { id: 'pdf-editor', label: 'Invitation PDF', icon: FileEdit },
  { id: 'whatsapp', label: 'Connect WhatsApp', icon: Smartphone },
  { id: 'send', label: 'Send', icon: Send }
];

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab, done }) => {
  const itemClass = (isActive: boolean) =>
    `w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition ${
      isActive ? 'bg-emerald-50 text-emerald-900 font-semibold shadow-xs' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
    }`;

  return (
    <aside className="w-60 bg-white border-r border-slate-200 flex flex-col h-screen shrink-0">
      <div className="p-5 border-b border-slate-100 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-700 flex items-center justify-center text-white shadow-md shadow-emerald-600/20">
          <Send className="w-5 h-5 -rotate-12" />
        </div>
        <div>
          <h1 className="font-bold text-slate-900 text-sm tracking-tight leading-tight">WhatsApp Inviter</h1>
          <p className="text-[11px] font-medium text-emerald-700 flex items-center gap-1 mt-0.5">
            <ShieldCheck className="w-3 h-3 text-emerald-600" />
            Runs on this PC only
          </p>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {STEPS.map((step, i) => {
          const isActive = currentTab === step.id;
          return (
            <button key={step.id} onClick={() => onSelectTab(step.id)} className={itemClass(isActive)}>
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${
                  done[step.id] ? 'bg-emerald-100 text-emerald-700' : isActive ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'
                }`}
              >
                {done[step.id] ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
              </span>
              <span>{step.label}</span>
            </button>
          );
        })}

        <div className="pt-3 mt-3 border-t border-slate-100">
          <button onClick={() => onSelectTab('history')} className={itemClass(currentTab === 'history')}>
            <History className="w-4 h-4 text-slate-400" />
            <span>Sent History</span>
          </button>
        </div>
      </nav>
    </aside>
  );
};
