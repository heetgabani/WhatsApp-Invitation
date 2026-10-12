import React, { useState, useEffect } from 'react';
import {
  Users,
  CheckCircle2,
  AlertCircle,
  Copy,
  Edit2,
  Check,
  X,
  Search,
  FileSpreadsheet,
  ArrowRight
} from 'lucide-react';
import Papa from 'papaparse';
import { api } from '../services/api';
import { ProcessedContact, CsvParseResult } from '../types';
import { useToast } from '../components/Toast';

interface ContactManagerPageProps {
  /** Receives the full contact list (with selection) whenever it changes */
  onContactsChange: (contacts: ProcessedContact[]) => void;
  onNext: () => void;
}

export const ContactManagerPage: React.FC<ContactManagerPageProps> = ({ onContactsChange, onNext }) => {
  const { success, error } = useToast();

  // The uploaded file is kept so the columns can be re-mapped without choosing it again
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [parseResult, setParseResult] = useState<CsvParseResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Column Mapping
  const [nameColumn, setNameColumn] = useState<string>('');
  const [phoneColumn, setPhoneColumn] = useState<string>('');

  // Table filter & search
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'valid' | 'invalid' | 'selected'>('all');

  // Inline Editing
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');

  // Parse a CSV. Columns are only passed for an explicit re-mapping of the same file;
  // a newly chosen file is auto-detected, since the previous file's column names may not exist in it.
  const parseFile = async (file: File, customNameCol?: string, customPhoneCol?: string) => {
    setIsLoading(true);
    try {
      const res = await api.parseCsvUpload(file, customNameCol, customPhoneCol);
      setCsvFile(file);
      setParseResult(res);
      setNameColumn(res.suggestedNameColumn || '');
      setPhoneColumn(res.suggestedPhoneColumn || '');
      success('Contacts Loaded', `${res.totalRows} rows, ${res.validRows} valid.`);
    } catch (err: any) {
      error('Could not read CSV', err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again after editing it
    if (file) parseFile(file);
  };

  // Share the list (including selection and edits) with the rest of the flow
  useEffect(() => {
    onContactsChange(parseResult?.contacts || []);
  }, [parseResult]);

  // Update column mapping
  const handleApplyMapping = () => {
    if (csvFile) parseFile(csvFile, nameColumn, phoneColumn);
  };

  // Toggle selection
  const handleToggleSelect = (index: number) => {
    if (!parseResult) return;
    setParseResult(prev => {
      if (!prev) return null;
      const updated = [...prev.contacts];
      updated[index] = { ...updated[index], selected: !updated[index].selected };
      return { ...prev, contacts: updated };
    });
  };

  // Download invalid/duplicate rows as CSV so they can be corrected in Excel (original file untouched)
  const handleExportInvalid = () => {
    const invalid = (parseResult?.contacts || []).filter(c => !c.isValid);
    if (invalid.length === 0) {
      success('Nothing to export', 'All rows are valid.');
      return;
    }
    const csv = Papa.unparse(
      invalid.map(c => ({
        row: c.index + 2, // +1 for the header line, +1 for 1-based numbering
        name: c.name,
        phone: c.rawPhone,
        problem: c.validationError || (c.isDuplicate ? 'Duplicate phone number' : 'Invalid'),
        ...c.customFields
      }))
    );
    // BOM so Excel opens Gujarati/Hindi names correctly
    const blob = new Blob([String.fromCharCode(0xfeff) + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'invalid_contacts.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  // Bulk select / deselect
  const handleBulkSelect = (select: boolean) => {
    if (!parseResult) return;
    setParseResult(prev => {
      if (!prev) return null;
      const updated = prev.contacts.map(c => ({
        ...c,
        selected: select ? c.isValid : false
      }));
      return { ...prev, contacts: updated };
    });
  };

  // Start inline editing
  const handleStartEdit = (contact: ProcessedContact) => {
    setEditingIndex(contact.index);
    setEditName(contact.name);
    setEditPhone(contact.phone);
  };

  // Save inline edit
  const handleSaveEdit = (index: number) => {
    if (!parseResult) return;
    setParseResult(prev => {
      if (!prev) return null;
      const updated = [...prev.contacts];
      const target = updated[index];

      const cleanPhone = editPhone.trim().replace(/[\s\-\(\)\.]/g, '');
      const isValid = Boolean(editName.trim() && cleanPhone.length >= 10 && cleanPhone.length <= 15);

      updated[index] = {
        ...target,
        name: editName.trim(),
        phone: cleanPhone,
        isValid,
        validationError: isValid ? undefined : 'Invalid name or phone number',
        selected: isValid ? target.selected : false
      };
      return { ...prev, contacts: updated };
    });
    setEditingIndex(null);
    success('Contact Updated', `Saved changes for ${editName}`);
  };

  // Filtered contacts
  const filteredContacts = (parseResult?.contacts || []).filter(c => {
    const matchesSearch =
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.phone.includes(searchTerm);

    if (!matchesSearch) return false;

    if (statusFilter === 'valid') return c.isValid;
    if (statusFilter === 'invalid') return !c.isValid && !c.isDuplicate;
    if (statusFilter === 'selected') return c.selected;
    return true;
  });

  const selectedCount = (parseResult?.contacts || []).filter(c => c.selected).length;

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-150">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Users className="w-6 h-6 text-emerald-600" />
            Step 1: Upload Contacts
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Upload a CSV with your guests' names and phone numbers. English, Gujarati and Hindi names are supported.
          </p>
        </div>

        {selectedCount > 0 && (
          <button
            onClick={onNext}
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg shadow-sm transition active:scale-95"
          >
            <span>Next: Invitation PDF ({selectedCount} guests)</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* CSV Selection Box */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-xs space-y-4">
        <label
          className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl px-6 py-8 cursor-pointer transition ${
            isLoading ? 'border-slate-200 bg-slate-50' : 'border-emerald-300 bg-emerald-50/40 hover:bg-emerald-50'
          }`}
        >
          <FileSpreadsheet className="w-8 h-8 text-emerald-600" />
          <span className="text-sm font-semibold text-slate-900">
            {isLoading ? 'Reading CSV…' : csvFile ? `Loaded: ${csvFile.name} (click to choose another file)` : 'Choose CSV file'}
          </span>
          <span className="text-xs text-slate-500">
            Needs a name column and a phone column, e.g. <code className="font-mono">name,phone</code>. 10-digit Indian numbers get +91 added.
          </span>
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={handleFileUpload} disabled={isLoading} />
        </label>

        {/* Column Mapping Section */}
        {parseResult && parseResult.headers.length > 0 && (
          <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center gap-4 text-xs">
            <span className="font-semibold text-slate-700 uppercase tracking-wider text-[11px]">
              Column Mapping:
            </span>

            <div className="flex items-center gap-2">
              <label className="text-slate-600 font-medium">Guest Name:</label>
              <select
                value={nameColumn}
                onChange={e => setNameColumn(e.target.value)}
                className="border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-800 font-medium outline-none focus:ring-1 focus:ring-emerald-500"
              >
                {parseResult.headers.map(h => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-slate-600 font-medium">Phone Number:</label>
              <select
                value={phoneColumn}
                onChange={e => setPhoneColumn(e.target.value)}
                className="border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-800 font-medium outline-none focus:ring-1 focus:ring-emerald-500"
              >
                {parseResult.headers.map(h => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </div>

            <button
              onClick={handleApplyMapping}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium transition"
            >
              Apply Mapping
            </button>
          </div>
        )}
      </div>

      {/* Summary KPI Badges */}
      {parseResult && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white p-4 rounded-lg border border-slate-200">
            <span className="text-[11px] font-semibold text-slate-500 uppercase">Total Rows</span>
            <div className="text-xl font-bold text-slate-900 mt-0.5">{parseResult.totalRows}</div>
          </div>
          <div className="bg-emerald-50/60 p-4 rounded-lg border border-emerald-200">
            <span className="text-[11px] font-semibold text-emerald-800 uppercase">Valid Contacts</span>
            <div className="text-xl font-bold text-emerald-950 mt-0.5">{parseResult.validRows}</div>
          </div>
          <div className="bg-amber-50/60 p-4 rounded-lg border border-amber-200">
            <span className="text-[11px] font-semibold text-amber-800 uppercase">Duplicates</span>
            <div className="text-xl font-bold text-amber-950 mt-0.5">{parseResult.duplicateRows}</div>
          </div>
          <div className="bg-blue-50/60 p-4 rounded-lg border border-blue-200">
            <span className="text-[11px] font-semibold text-blue-800 uppercase">Selected to Send</span>
            <div className="text-xl font-bold text-blue-950 mt-0.5">{selectedCount}</div>
          </div>
        </div>
      )}

      {/* Contact Table Card */}
      {parseResult && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
          {/* Controls Bar */}
          <div className="p-4 border-b border-slate-200 bg-slate-50/50 flex flex-col md:flex-row items-center justify-between gap-3">
            {/* Search */}
            <div className="relative w-full md:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search name or phone..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full text-xs pl-9 pr-3 py-2 border border-slate-300 rounded-lg bg-white outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              />
            </div>

            {/* Filter Tabs & Bulk Actions */}
            <div className="flex flex-wrap items-center gap-2 w-full md:w-auto justify-between md:justify-end">
              <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-1 text-xs">
                {(['all', 'valid', 'invalid', 'selected'] as const).map(tab => (
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

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleBulkSelect(true)}
                  className="px-2.5 py-1.5 text-xs font-semibold bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg transition"
                >
                  Select Valid
                </button>
                <button
                  onClick={() => handleBulkSelect(false)}
                  className="px-2.5 py-1.5 text-xs font-semibold bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg transition"
                >
                  Deselect All
                </button>
                <button
                  onClick={handleExportInvalid}
                  title="Download invalid and duplicate rows as a CSV to fix them"
                  className="px-2.5 py-1.5 text-xs font-semibold bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg transition"
                >
                  Export Invalid
                </button>
              </div>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto max-h-[500px]">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider sticky top-0 z-10">
                <tr>
                  <th className="py-3 px-4 w-12 text-center">Send</th>
                  <th className="py-3 px-4 w-12">#</th>
                  <th className="py-3 px-4">Guest Name</th>
                  <th className="py-3 px-4">Phone Number</th>
                  <th className="py-3 px-4">Status & Validation</th>
                  <th className="py-3 px-4">Custom Fields</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {filteredContacts.map(c => {
                  const isEditing = editingIndex === c.index;

                  return (
                    <tr
                      key={c.index}
                      className={`hover:bg-slate-50/70 transition ${
                        c.selected ? 'bg-emerald-50/20' : ''
                      } ${!c.isValid ? 'bg-rose-50/20' : ''}`}
                    >
                      {/* Checkbox */}
                      <td className="py-3 px-4 text-center">
                        <input
                          type="checkbox"
                          checked={c.selected}
                          disabled={!c.isValid && !isEditing}
                          onChange={() => handleToggleSelect(c.index)}
                          className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer disabled:opacity-30"
                        />
                      </td>

                      {/* Index */}
                      <td className="py-3 px-4 font-mono text-slate-400">{c.index + 1}</td>

                      {/* Name */}
                      <td className="py-3 px-4 font-medium text-slate-900">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editName}
                            onChange={e => setEditName(e.target.value)}
                            className="border border-emerald-400 rounded px-2 py-1 text-xs w-full bg-white font-medium"
                          />
                        ) : (
                          <span className="text-sm font-semibold">{c.name}</span>
                        )}
                      </td>

                      {/* Phone */}
                      <td className="py-3 px-4 font-mono">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editPhone}
                            onChange={e => setEditPhone(e.target.value)}
                            className="border border-emerald-400 rounded px-2 py-1 text-xs w-full bg-white font-mono"
                          />
                        ) : (
                          <span>+{c.phone}</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4">
                        {c.isDuplicate ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                            <Copy className="w-3 h-3" /> Duplicate Phone
                          </span>
                        ) : c.isValid ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                            <CheckCircle2 className="w-3 h-3" /> Valid
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 bg-rose-100 px-2 py-0.5 rounded-full" title={c.validationError}>
                            <AlertCircle className="w-3 h-3" /> {c.validationError || 'Invalid'}
                          </span>
                        )}
                      </td>

                      {/* Custom Fields */}
                      <td className="py-3 px-4 text-slate-500 text-[11px]">
                        {Object.entries(c.customFields).map(([k, v]) => (
                          <span key={k} className="inline-block bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded mr-1">
                            {k}: {v}
                          </span>
                        ))}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right">
                        {isEditing ? (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => handleSaveEdit(c.index)}
                              className="p-1 text-emerald-600 hover:bg-emerald-50 rounded"
                              title="Save"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => setEditingIndex(null)}
                              className="p-1 text-slate-400 hover:bg-slate-100 rounded"
                              title="Cancel"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleStartEdit(c)}
                            className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                            title="Edit Contact"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Table Footer */}
          <div className="p-3 border-t border-slate-100 bg-slate-50 text-xs text-slate-500 flex items-center justify-between">
            <span>Showing {filteredContacts.length} of {parseResult.contacts.length} total contacts</span>
            <span className="font-semibold text-emerald-700">
              {selectedCount} recipients will receive invitations
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

