import { describe, it, expect } from 'vitest';
import { parseCsvContent, sanitizePhoneNumber } from '../src/services/csvService.js';

describe('CSV Service & Contact Validation', () => {
  it('should sanitize and validate phone numbers properly', () => {
    // Standard 10 digit Indian number without country code
    const p1 = sanitizePhoneNumber('9876543210');
    expect(p1.isValid).toBe(true);
    expect(p1.phone).toBe('919876543210');

    // Number with leading +, dashes, spaces
    const p2 = sanitizePhoneNumber('+91 98765-43210');
    expect(p2.isValid).toBe(true);
    expect(p2.phone).toBe('919876543210');

    // Invalid non-numeric
    const p3 = sanitizePhoneNumber('abcdef1234');
    expect(p3.isValid).toBe(false);

    // Invalid length
    const p4 = sanitizePhoneNumber('12345');
    expect(p4.isValid).toBe(false);
  });

  it('should parse Unicode names in Gujarati, Hindi, and English', () => {
    const csvContent = `phone,name,relationship
919876543210,Rahul Shah,Friend
919876543211,પ્રિયા પટેલ,Cousin
919876543212,आरव मेहता,Family
919876543213,,Missing Name
919876543210,Rahul Duplicate,Friend
`;

    const result = parseCsvContent(csvContent, 'name', 'phone');

    expect(result.totalRows).toBe(5);
    expect(result.validRows).toBe(3); // 3 unique valid
    expect(result.invalidRows).toBe(2); // 1 empty name, 1 duplicate phone
    expect(result.duplicateRows).toBe(1);

    // Verify Gujarati Unicode preservation
    const gujaratiContact = result.contacts.find(c => c.name === 'પ્રિયા પટેલ');
    expect(gujaratiContact).toBeDefined();
    expect(gujaratiContact?.isValid).toBe(true);
    expect(gujaratiContact?.phone).toBe('919876543211');

    // Verify Hindi Unicode preservation
    const hindiContact = result.contacts.find(c => c.name === 'आरव मेहता');
    expect(hindiContact).toBeDefined();
    expect(hindiContact?.isValid).toBe(true);
    expect(hindiContact?.phone).toBe('919876543212');

    // Verify duplicate detection
    const duplicateContact = result.contacts[4];
    expect(duplicateContact.isDuplicate).toBe(true);
    expect(duplicateContact.isValid).toBe(false);
  });

  it('should auto-detect header names when not explicitly provided', () => {
    const csvContent = `mobile,full_name
919876543210,Aarav Mehta
`;
    const result = parseCsvContent(csvContent);
    expect(result.suggestedPhoneColumn).toBe('mobile');
    expect(result.suggestedNameColumn).toBe('full_name');
    expect(result.validRows).toBe(1);
    expect(result.contacts[0].name).toBe('Aarav Mehta');
  });

  it('should fall back to auto-detection when a requested column is not in the file', () => {
    // The mapping left over from a previous file ('phone') must not blank out this file's numbers
    const csvContent = 'name,number\r\nTest Guest,9876501234';
    const result = parseCsvContent(csvContent, 'name', 'phone');
    expect(result.suggestedPhoneColumn).toBe('number');
    expect(result.validRows).toBe(1);
    expect(result.contacts[0].phone).toBe('919876501234');
  });
});

