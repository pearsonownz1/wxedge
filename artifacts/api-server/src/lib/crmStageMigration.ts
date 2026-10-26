import { CrmError, activity, deduplicateInvestors, ensureCrmTablesAndDefaults, type Client } from "./crmData";
import { normalizeStage, STAGES } from "./crmStages";

// Called inside transaction(), which also takes the same lock as every CRM write.
// Only data.status changes. IDs, categories, pitches, contact dates and existing
// activities remain untouched. A separate activity preserves the original stage.
export async function migratePipelineStages(client: Client) {
  const { rows } = await client.query("SELECT id,data->>'status' AS status FROM crm_investors ORDER BY id FOR UPDATE");
  const before: Record<string, number> = {};
  const after: Record<string, number> = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  const planned = rows.map(row => {
    const original = row.status as string | null;
    const stage = original == null || !original.trim() ? "New" : normalizeStage(original);
    if (!stage) throw new CrmError(`Unrecognized existing stage on expert ${row.id}; migration stopped without changes`);
    const label = original ?? "<missing>";
    before[label] = (before[label] ?? 0) + 1;
    after[stage]++;
    return { id: row.id, original, stage };
  });
  let changed = 0;
  for (const row of planned) {
    if (row.original === row.stage) continue;
    const result = await client.query(
      "UPDATE crm_investors SET data=jsonb_set(data,'{status}',to_jsonb($1::text),true) WHERE id=$2 AND data->>'status' IS NOT DISTINCT FROM $3 RETURNING id",
      [row.stage, row.id, row.original],
    );
    if (result.rows.length !== 1) throw new CrmError("Stage migration changed an unexpected number of records; rolled back");
    await activity(client, row.id, `Pipeline stages simplified: ${row.original ?? "No stage"} → ${row.stage}`, `stage_migration:${row.original ?? "New"}`);
    changed++;
  }
  return { total: rows.length, changed, before, after };
}

export async function bootstrapCrmUpgrades(client: Client) {
  await ensureCrmTablesAndDefaults(client);
  const stageReport = await migratePipelineStages(client);
  const dedupReport = await deduplicateInvestors(client);
  return { stageReport, dedupReport };
}
