import type { AppConfig, MappingConfig } from '../types.js';

/** 分组名最大长度（按字符计，不按 UTF-16 单元）。 */
export const GROUP_NAME_MAX = 24;

type GroupSource = Pick<MappingConfig, 'group'>;
type GroupDraft = Pick<AppConfig, 'mappings' | 'mappingGroupOrder'>;

const UNGROUPED_LABEL = '未分组';

/**
 * Normalises a user supplied group name: collapses whitespace, drops control
 * characters and truncates to GROUP_NAME_MAX. Empty string means "未分组";
 * the label itself is reserved and also normalises to "未分组".
 */
export function normalizeGroupName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text === UNGROUPED_LABEL) return '';
  return Array.from(text).slice(0, GROUP_NAME_MAX).join('').trim();
}

/** Names that actually have at least one mapping, in first-appearance order. */
export function groupNames(mappings: GroupSource[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const mapping of mappings) {
    const name = normalizeGroupName(mapping.group);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/**
 * Rebuilds the persisted group order: keep the stored order for groups that
 * still exist, then append newly created groups in first-appearance order.
 * Unknown and empty names are dropped, so the UI never renders empty sections.
 */
export function normalizeGroupOrder(input: unknown, mappings: GroupSource[]): string[] {
  const present = groupNames(mappings);
  const presentSet = new Set(present);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of Array.isArray(input) ? input : []) {
    const name = normalizeGroupName(item);
    if (!name || !presentSet.has(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  for (const name of present) {
    if (seen.has(name)) continue;
    result.push(name);
  }
  return result;
}

/** Renames a group in place; returns how many mappings moved. */
export function renameGroupInConfig(draft: GroupDraft, fromRaw: string, toRaw: string): number {
  const from = normalizeGroupName(fromRaw);
  const to = normalizeGroupName(toRaw);
  if (!from || !to || from === to) return 0;
  let changed = 0;
  for (const mapping of draft.mappings) {
    if (normalizeGroupName(mapping.group) !== from) continue;
    mapping.group = to;
    mapping.updatedAt = new Date().toISOString();
    changed += 1;
  }
  if (changed > 0) {
    draft.mappingGroupOrder = normalizeGroupOrder(
      draft.mappingGroupOrder.map((name) => (normalizeGroupName(name) === from ? to : name)),
      draft.mappings,
    );
  }
  return changed;
}

/** Moves every mapping of a group back to "未分组"; returns how many moved. */
export function clearGroupInConfig(draft: GroupDraft, raw: string): number {
  const name = normalizeGroupName(raw);
  if (!name) return 0;
  let moved = 0;
  for (const mapping of draft.mappings) {
    if (normalizeGroupName(mapping.group) !== name) continue;
    mapping.group = '';
    mapping.updatedAt = new Date().toISOString();
    moved += 1;
  }
  if (moved > 0) {
    draft.mappingGroupOrder = normalizeGroupOrder(draft.mappingGroupOrder, draft.mappings);
  }
  return moved;
}
