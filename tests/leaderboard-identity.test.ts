// Release dates of models a source introduced follow that source when it corrects them (an early
// listing date otherwise stays forever), and another source never overwrites them.
import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { IdentityResolver } from '@aihot/backend/leaderboard/fetch/identity';

after(closeDb);

test('a release date follows the source it came from, and only that source', async () => {
  const name = `Release Model ${tag()}`;
  const released = async (id: string) => (await sql<{ d: string; s: string }[]>`SELECT released_at::date::text AS d, release_date_source AS s FROM lb_models WHERE id = ${id}`)[0];

  const id = await (await new IdentityResolver('artificial-analysis').load()).resolve([name], name, { organization: 'OpenAI', releasedAt: '2026-09-17' });
  const [created] = await sql<{ provider: string; provider_slug: string }[]>`SELECT provider, provider_slug FROM lb_models WHERE id = ${id}`;
  assert.deepEqual(created, { provider: 'OpenAI', provider_slug: 'openai' }, 'the provider is inferred when the model is created');

  await (await new IdentityResolver('epoch-gpqa').load()).resolve([name], name, { releasedAt: '2026-01-01' });
  assert.deepEqual(await released(id), { d: '2026-09-17', s: 'artificial-analysis' }, 'another source does not overwrite the date');

  await (await new IdentityResolver('artificial-analysis').load()).resolve([name], name, { releasedAt: '2026-09-22' });
  assert.deepEqual(await released(id), { d: '2026-09-22', s: 'artificial-analysis' }, 'the source corrects its own date');
});
