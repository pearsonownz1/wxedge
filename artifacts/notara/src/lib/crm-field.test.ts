import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultExpertFieldFor, expertFieldOf, filterExpertField, TEMPLATE_CSV, STATUSES, STATUS_TONE } from './crm';

test('All CRM views share exactly six ordered stages', () => {
  assert.deepEqual(STATUSES, ['New', 'Contacted', 'Followed Up', 'Responded', 'Meeting Set', 'Closed']);
  assert.deepEqual(Object.keys(STATUS_TONE), [...STATUSES]);
});

test('Field filtering includes legacy experts under Dentistry without changing records', () => {
  const records: { id: number; expert_field?: string | null }[] = [
    { id: 1 }, { id: 2, expert_field: 'Dentistry' },
    { id: 3, expert_field: 'Economics' }, { id: 4, expert_field: null },
    { id: 5, expert_field: 'Law Firms' },
  ];
  const before = JSON.stringify(records);
  assert.deepEqual(filterExpertField(records, 'Dentistry').map(r => r.id), [1, 2, 4]);
  assert.deepEqual(filterExpertField(records, 'Economics').map(r => r.id), [3]);
  assert.deepEqual(filterExpertField(records, 'Law Firms').map(r => r.id), [5]);
  assert.equal(filterExpertField(records.slice(0, 4), 'Law Firms').length, 0);
  assert.equal(filterExpertField(records, 'All').length, 5);
  assert.equal(expertFieldOf(records[0]), 'Dentistry');
  assert.equal(JSON.stringify(records), before);
});

test('New expert defaults follow the selected field, and CSV includes expert_field', () => {
  assert.equal(defaultExpertFieldFor('Economics'), 'Economics');
  assert.equal(defaultExpertFieldFor('Law Firms'), 'Law Firms');
  assert.equal(defaultExpertFieldFor('Dentistry'), 'Dentistry');
  assert.equal(defaultExpertFieldFor('All'), 'Dentistry');
  assert.ok(TEMPLATE_CSV.trim().split(',').includes('expert_field'));
});
