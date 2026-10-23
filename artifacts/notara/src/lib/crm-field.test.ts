import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultExpertFieldFor, expertFieldOf, filterExpertField, TEMPLATE_CSV, STATUSES, STATUS_TONE, EXPERT_FIELDS, EXPERT_FIELD_FILTERS } from './crm';

test('All CRM views share exactly six ordered stages', () => {
  assert.deepEqual(STATUSES, ['New', 'Contacted', 'Followed Up', 'Responded', 'Meeting Set', 'Closed']);
  assert.deepEqual(Object.keys(STATUS_TONE), [...STATUSES]);
});

test('Field filtering includes legacy experts under Dentistry without changing records', () => {
  const records: { id: number; expert_field?: string | null }[] = [
    { id: 1 }, { id: 2, expert_field: 'Dentistry' },
    { id: 3, expert_field: 'Economics' }, { id: 4, expert_field: null },
    { id: 5, expert_field: 'Law Firms' },
    { id: 6, expert_field: 'Chinese Law' },
    { id: 7, expert_field: 'Indian Law' },
  ];
  const before = JSON.stringify(records);
  assert.deepEqual(filterExpertField(records, 'Dentistry').map(r => r.id), [1, 2, 4]);
  assert.deepEqual(filterExpertField(records, 'Economics').map(r => r.id), [3]);
  assert.deepEqual(filterExpertField(records, 'Law Firms').map(r => r.id), [5]);
  assert.deepEqual(filterExpertField(records, 'Chinese Law').map(r => r.id), [6]);
  assert.deepEqual(filterExpertField(records, 'Indian Law').map(r => r.id), [7]);
  assert.equal(filterExpertField(records.slice(0, 4), 'Law Firms').length, 0);
  assert.equal(filterExpertField(records, 'All').length, 7);
  assert.equal(expertFieldOf(records[0]), 'Dentistry');
  assert.equal(JSON.stringify(records), before);
});

test('New expert defaults follow the selected field, and CSV includes expert_field', () => {
  assert.ok(EXPERT_FIELDS.includes('Chinese Law'));
  assert.ok(EXPERT_FIELDS.includes('Indian Law'));
  assert.ok(!EXPERT_FIELDS.some(field => String(field) === 'Brazilian Law'));
  assert.deepEqual(EXPERT_FIELD_FILTERS.find(field => field.value === 'Chinese Law'), { value: 'Chinese Law', label: 'Chinese Law' });
  assert.deepEqual(EXPERT_FIELD_FILTERS.find(field => field.value === 'Indian Law'), { value: 'Indian Law', label: 'Indian Law' });
  assert.deepEqual(EXPERT_FIELD_FILTERS.find(field => field.value === 'Law Firms'), { value: 'Law Firms', label: 'Brazil' });
  assert.ok(!EXPERT_FIELD_FILTERS.some(field => String(field.value) === 'Brazilian Law'));
  assert.equal(defaultExpertFieldFor('Economics'), 'Economics');
  assert.equal(defaultExpertFieldFor('Law Firms'), 'Law Firms');
  assert.equal(defaultExpertFieldFor('Chinese Law'), 'Chinese Law');
  assert.equal(defaultExpertFieldFor('Indian Law'), 'Indian Law');
  assert.equal(defaultExpertFieldFor('Dentistry'), 'Dentistry');
  assert.equal(defaultExpertFieldFor('All'), 'Dentistry');
  assert.ok(TEMPLATE_CSV.trim().split(',').includes('expert_field'));
});
