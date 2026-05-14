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

function collectRenderTexts(node: unknown, out: string[]): void {
  if (node === undefined || node === null) return;
  if (typeof node === 'string') {
    const s = node.trim();
    if (s) out.push(s);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectRenderTexts(item, out);
    return;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    // CardRenderItem with type='text' stores its content in .text
    if (obj.type === 'text' && typeof obj.text === 'string' && obj.text.trim()) {
      out.push(obj.text.trim());
    }
    if (Array.isArray(obj.rows)) collectRenderTexts(obj.rows, out);
  }
}

function extractDescriptionFromRenderData(renderData: unknown): string {
  const texts: string[] = [];
  collectRenderTexts(renderData, texts);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const t of texts) {
    if (!seen.has(t)) { seen.add(t); deduped.push(t); }
  }
  return deduped.join(' ');
}

function extractDescription(card: ICard): string {
  const metadata = (card as unknown as {metadata?: {description?: unknown; renderData?: unknown}}).metadata;
  if (!metadata) return '';
  const desc = metadata.description;
  if (typeof desc === 'string' && desc.trim()) return desc.trim();
  if (desc && typeof desc === 'object' && 'text' in desc) {
    const t = String((desc as {text: unknown}).text).trim();
    if (t) return t;
  }
  // Fallback: extract human-readable text from renderData (e.g. b.text(), b.action(), b.plainText())
  if (metadata.renderData) return extractDescriptionFromRenderData(metadata.renderData);
  return '';
}

function processManifest<T extends ICard>(manifest: CardManifest<T>) {
  for (const spec of CardManifest.values(manifest)) {
    if (spec.instantiate === false) continue;
    try {
      const card = new spec.Factory();
      const desc = extractDescription(card);
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
