/**
 * Extracts card metadata from all manifests and prints JSON to stdout.
 * Usage: npx tsx src/server/tools/extract_card_db.ts > tm-ai/data/card_db.json
 */
import {ALL_MODULE_MANIFESTS} from '../cards/AllManifests';
import {CardManifest} from '../cards/ModuleManifest';
import {ICard} from '../cards/ICard';

interface CardEntry {
  name: string;
  type: string;
  cost: number | null;
  tags: string[];
  description: string;
  victoryPoints: number | string | Record<string, unknown> | null;
}

const db: Record<string, CardEntry> = {};

function extractDescription(desc: unknown): string {
  if (typeof desc === 'string') return desc;
  if (desc && typeof desc === 'object' && 'text' in desc) return String((desc as {text: unknown}).text);
  return '';
}

function processManifest<T extends ICard>(manifest: CardManifest<T>) {
  for (const spec of CardManifest.values(manifest)) {
    if (spec.instantiate === false) continue;
    try {
      const card = new spec.Factory();
      const desc = extractDescription((card as unknown as {metadata?: {description?: unknown}}).metadata?.description);
      const tags = (card.tags ?? []).map(String);
      db[card.name] = {
        name: card.name,
        type: String(card.type),
        cost: (card as unknown as {cost?: number}).cost ?? null,
        tags,
        description: desc,
        victoryPoints: card.victoryPoints ?? null,
      };
    } catch {
      // skip cards that fail to instantiate
    }
  }
}

for (const manifest of ALL_MODULE_MANIFESTS) {
  processManifest(manifest.projectCards);
  processManifest(manifest.corporationCards);
  processManifest(manifest.preludeCards);
  if (manifest.ceoCards) processManifest(manifest.ceoCards);
}

process.stdout.write(JSON.stringify(db, null, 2) + '\n');
