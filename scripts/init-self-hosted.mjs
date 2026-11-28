import { readFile, writeFile } from 'node:fs/promises';

const [name, databaseId] = process.argv.slice(2);
if (
  !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(name ?? '') ||
  !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(databaseId ?? '')
) {
  console.error('Usage: npm run init:self-hosted -- <worker-and-database-name> <D1-database-id>');
  process.exit(1);
}
const template = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
template.name = name;
Object.assign(template.d1_databases[0], { database_name: name, database_id: databaseId });
try {
  await writeFile('wrangler.self-hosted.jsonc', JSON.stringify(template, null, 2) + '\n', { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error(
    'wrangler.self-hosted.jsonc already exists. Keep it for upgrades or choose a fresh checkout.',
  );
  process.exit(1);
}
console.log(
  'Created wrangler.self-hosted.jsonc. Next: npm run db:migrate:remote and npm run deploy:self-hosted.',
);
