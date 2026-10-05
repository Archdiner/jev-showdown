import fs from 'fs';

test('guidance corpus is 65 general principles', () => {
  const rows = JSON.parse(fs.readFileSync('state/meta/guidance.json', 'utf8')) as Array<{
    id: string;
    topic: string;
    principle: string;
    when_applies: string;
    confidence: string;
  }>;
  expect(rows).toHaveLength(65);
  expect(rows[0]?.id).toBe('G01');
  expect(rows.every(row => row.topic && row.principle && row.when_applies && row.confidence)).toBe(true);
});

test('hypothesis list is stored and not required by the loader', () => {
  const rows = JSON.parse(fs.readFileSync('state/meta/hypotheses.json', 'utf8')) as Array<{ id: string; change: string }>;
  expect(rows).toHaveLength(16);
  expect(rows[0]?.id).toBe('H01');
  expect(rows.every(row => row.id && row.change)).toBe(true);
});
