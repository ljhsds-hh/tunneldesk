import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tunneldesk-test-'));
process.env.TUNNELDESK_DATA_DIR = sandbox;

const { ConfigStore, configPath } = await import('../src/config/store.js');
const {
  normalizeGroupName,
  normalizeGroupOrder,
  renameGroupInConfig,
  clearGroupInConfig,
} = await import('../src/config/groups.js');

describe('ConfigStore', () => {
  beforeAll(() => {
    fs.rmSync(path.join(sandbox, 'TunnelDesk'), { recursive: true, force: true });
  });

  it('starts from defaults when no file exists', async () => {
    const store = new ConfigStore();
    const config = await store.load();
    expect(config.hosts).toEqual([]);
    expect(config.proxy.port).toBe(8888);
    expect(config.proxy.routingMode).toBe('all');
    expect(config.proxy.whitelist).toEqual([]);
  });

  it('persists updates atomically and reloads them', async () => {
    const store = new ConfigStore();
    await store.load();
    await store.update((draft) => {
      draft.proxy.port = 8899;
      draft.mappings.push({
        id: 'map_test',
        name: '测试映射',
        hostId: 'host_test',
        bindAddress: '127.0.0.1',
        localPort: 13389,
        targetHost: '127.0.0.1',
        targetPort: 3389,
        enabled: true,
        autoStart: true,
        syncFirewall: true,
        group: ' 数据库 ',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      draft.mappingGroupOrder = ['数据库'];
    });
    expect(fs.existsSync(configPath())).toBe(true);
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as { proxy: { port: number } };
    expect(raw.proxy.port).toBe(8899);

    const reloaded = new ConfigStore();
    const config = await reloaded.load();
    expect(config.mappings).toHaveLength(1);
    expect(config.mappings[0]?.name).toBe('测试映射');
    expect(config.mappings[0]?.group).toBe('数据库');
    expect(config.mappingGroupOrder).toEqual(['数据库']);
  });

  it('sanitises PAC routing settings when reloading', async () => {
    const store = new ConfigStore();
    await store.load();
    await store.update((draft) => {
      draft.proxy.routingMode = 'whitelist';
      draft.proxy.whitelist = ['10.1.2.3', 'bad-host', '10.1.2.3'];
    });

    const reloaded = new ConfigStore();
    const config = await reloaded.load();
    expect(config.proxy.routingMode).toBe('whitelist');
    expect(config.proxy.whitelist).toEqual(['10.1.2.3']);
  });
});

describe('mapping groups', () => {
  function mapping(group: string, id = 'map_x') {
    return {
      id,
      name: id,
      hostId: 'host_1',
      bindAddress: '127.0.0.1',
      localPort: 13389,
      targetHost: '127.0.0.1',
      targetPort: 3389,
      enabled: true,
      autoStart: true,
      syncFirewall: true,
      group,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('normalises whitespace, control characters and length', () => {
    expect(normalizeGroupName('  数据库  ')).toBe('数据库');
    expect(normalizeGroupName('数据库\t\n 服务')).toBe('数据库 服务');
    expect(normalizeGroupName('a\u0000b')).toBe('a b');
    expect(normalizeGroupName('未分组')).toBe('');
    expect(normalizeGroupName('数'.repeat(40))).toHaveLength(24);
    expect(normalizeGroupName(undefined)).toBe('');
    expect(normalizeGroupName(42)).toBe('');
  });

  it('keeps saved order, drops stale names and appends new groups', () => {
    const mappings = [
      mapping('Web', 'a'),
      mapping('', 'b'),
      mapping('数据库', 'c'),
      mapping('Web ', 'd'),
      mapping('新分组', 'e'),
    ];
    expect(normalizeGroupOrder(['数据库', '已删除', 'Web', ''], mappings)).toEqual([
      '数据库',
      'Web',
      '新分组',
    ]);
    expect(normalizeGroupOrder(undefined, mappings)).toEqual(['Web', '数据库', '新分组']);
    expect(normalizeGroupOrder(['数据库'], [])).toEqual([]);
  });

  it('renames a group across every mapping and its order entry', () => {
    const draft = {
      mappings: [mapping('数据库', 'a'), mapping('数据库', 'b'), mapping('Web', 'c')],
      mappingGroupOrder: ['数据库', 'Web'],
    };
    expect(renameGroupInConfig(draft, ' 数据库 ', 'DB')).toBe(2);
    expect(draft.mappings.map((item) => item.group)).toEqual(['DB', 'DB', 'Web']);
    expect(draft.mappingGroupOrder).toEqual(['DB', 'Web']);
    expect(renameGroupInConfig(draft, '不存在', 'X')).toBe(0);
  });

  it('deletes a group by moving its mappings back to uncategorised', () => {
    const draft = {
      mappings: [mapping('数据库', 'a'), mapping('Web', 'b')],
      mappingGroupOrder: ['数据库', 'Web'],
    };
    expect(clearGroupInConfig(draft, '数据库')).toBe(1);
    expect(draft.mappings.map((item) => item.group)).toEqual(['', 'Web']);
    expect(draft.mappingGroupOrder).toEqual(['Web']);
    expect(clearGroupInConfig(draft, '不存在')).toBe(0);
  });
});
