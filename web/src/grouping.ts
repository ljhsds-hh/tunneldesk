import type { Mapping } from './types';

/** 分组名最大长度，与 server/src/config/groups.ts 保持一致。 */
export const GROUP_NAME_MAX = 24;
export const UNGROUPED_LABEL = '未分组';

export interface GroupSection {
  name: string;
  items: Mapping[];
}

export interface GroupedMappings {
  ordered: GroupSection[];
  ungrouped: Mapping[];
}

/** Mirrors server/src/config/groups.ts normalizeGroupName. */
export function normalizeGroupName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text === UNGROUPED_LABEL) return '';
  return Array.from(text).slice(0, GROUP_NAME_MAX).join('').trim();
}

export function groupLabel(name: string): string {
  return name || UNGROUPED_LABEL;
}

/**
 * Buckets mappings by normalised group name. Persisted order wins; groups that
 * are not listed yet keep their first-appearance order. Empty names always go
 * to the ungrouped bucket, which callers render last.
 */
export function buildGroupSections(
  mappings: Mapping[],
  order: readonly string[] | undefined,
): GroupedMappings {
  const byName = new Map<string, Mapping[]>();
  for (const mapping of mappings) {
    const name = normalizeGroupName(mapping.group);
    const bucket = byName.get(name);
    if (bucket) bucket.push(mapping);
    else byName.set(name, [mapping]);
  }

  const ordered: GroupSection[] = [];
  const seen = new Set<string>();
  for (const raw of order ?? []) {
    const name = normalizeGroupName(raw);
    const items = byName.get(name);
    if (!name || !items || seen.has(name)) continue;
    seen.add(name);
    ordered.push({ name, items });
  }
  for (const [name, items] of byName) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    ordered.push({ name, items });
  }

  return { ordered, ungrouped: byName.get('') ?? [] };
}
