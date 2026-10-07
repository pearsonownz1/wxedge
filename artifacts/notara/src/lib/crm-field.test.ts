import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultExpertFieldFor, expertFieldOf, filterExpertField, TEMPLATE_CSV } from './crm';

test('Field filtering includes legacy experts under Dentistry without changing records', () => {
  const records: { id: number; expert_field?: string | null }[] = [
    { id: 1 }, { id: 2, expert_field: 'Dentistry' },
    { id: 3, expert_field: 'Economics' }, { id: 4, expert_field: null },
  ];
  const before = JSON.stringify(records);
  assert.deepEqual(filterExpertField(records, 'Dentistry').map(r => r.id), [1, 2, 4]);
  assert.deepEqual(filterExpertField(records, 'Economics').map(r => r.id), [3]);
  assert.equal(filterExpertField(records, 'All').length, 4);
  assert.equal(expertFieldOf(records[0]), 'Dentistry');
  assert.equal(JSON.stringify(records), before);
});

test('New expert defaults follow the selected field, and CSV includes expert_field', () => {
  assert.equal(defaultExpertFieldFor('Economics'), 'Economics');
  assert.equal(defaultExpertFieldFor('Dentistry'), 'Dentistry');
  assert.equal(defaultExpertFieldFor('All'), 'Dentistry');
  assert.ok(TEMPLATE_CSV.trim().split(',').includes('expert_field'));
});
