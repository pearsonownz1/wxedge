import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultExpertFieldFor, expertFieldOf, filterExpertField, TEMPLATE_CSV, STATUSES, STATUS_TONE, EXPERT_FIELDS, EXPERT_FIELD_FILTERS } from './crm';

test('All CRM views share exactly six ordered stages', () => {
  assert.deepEqual(STATUSES, ['New', 'Contacted', 'Meeting set', 'Proposal sent', 'Contract review', 'Closed']);
  assert.deepEqual(Object.keys(STATUS_TONE), [...STATUSES]);
});

test('Field filtering defaults legacy records to Law Firms and filters law segments cleanly', () => {
  const records: { id: number; expert_field?: string | null }[] = [
    { id: 1 },
    { id: 2, expert_field: 'Law Firms' },
    { id: 3, expert_field: 'Chinese Law' },
    { id: 4, expert_field: 'Indian Law' },
  ];
  assert.deepEqual(filterExpertField(records, 'Law Firms').map(r => r.id), [1, 2]);
  assert.deepEqual(filterExpertField(records, 'Chinese Law').map(r => r.id), [3]);
  assert.deepEqual(filterExpertField(records, 'Indian Law').map(r => r.id), [4]);
  assert.equal(filterExpertField(records, 'All').length, 4);
  assert.equal(expertFieldOf(records[0]), 'Law Firms');
});

test('New law firm defaults follow the selected field, and CSV includes expert_field', () => {
  assert.deepEqual(EXPERT_FIELDS, ['Law Firms', 'Chinese Law', 'Indian Law']);
  assert.deepEqual(EXPERT_FIELD_FILTERS.find(field => field.value === 'Law Firms'), { value: 'Law Firms', label: 'Law Firms' });
  assert.deepEqual(EXPERT_FIELD_FILTERS.find(field => field.value === 'Chinese Law'), { value: 'Chinese Law', label: 'Chinese Law' });
  assert.deepEqual(EXPERT_FIELD_FILTERS.find(field => field.value === 'Indian Law'), { value: 'Indian Law', label: 'Indian Law' });
  assert.equal(defaultExpertFieldFor('Law Firms'), 'Law Firms');
  assert.equal(defaultExpertFieldFor('Chinese Law'), 'Chinese Law');
  assert.equal(defaultExpertFieldFor('Indian Law'), 'Indian Law');
  assert.equal(defaultExpertFieldFor('All'), 'Law Firms');
  assert.ok(TEMPLATE_CSV.trim().split(',').includes('expert_field'));
});
