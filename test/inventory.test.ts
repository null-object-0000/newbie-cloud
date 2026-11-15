import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  belongsToDomain,
  dnsState,
  domainInventory,
  domainName,
  freshDns,
  nsProvider,
  resourceRows,
} from '../src/inventory';
import { observeDns } from '../src/server/inventory';
import { Cloud } from '../src/server/providers';
import type { Account, Zone, ResourceSnapshot } from '../src/shared';

const accounts = [
  { id: 'cf', provider: 'cloudflare' },
  { id: 'ali', provider: 'aliyun' },
] as Account[];
const zones = [
  { id: 'cf:one', accountId: 'cf', name: 'EXAMPLE.COM.' },
  { id: 'ali:one', accountId: 'ali', name: 'example.com' },
] as Zone[];
const at = new Date().toISOString();
test('one domain merges registration and DNS inventories without confusing their roles', () => {
  const snapshots: ResourceSnapshot[] = [
    {
      account_id: 'ali',
      kind: 'registrations',
      updated_at: at,
      data: [
        {
          id: 'registered',
          name: 'example.com',
          registrar: '阿里云',
          nameservers: ['neil.ns.cloudflare.com'],
        },
        { id: 'registration-only', name: 'another.co.uk', registrar: '阿里云', nameservers: [] },
      ],
    },
  ];
  const domains = domainInventory(zones, snapshots);
  assert.equal(domains.length, 2);
  const one = domains.find((d) => d.name === 'example.com')!;
  assert.equal(one.zones.length, 2);
  assert.equal(one.registrations[0].accountId, 'ali');
  const observations = [
    {
      name: 'example.com',
      nameservers: ['neil.ns.cloudflare.com'],
      provider: 'cloudflare' as const,
      checkedAt: at,
    },
  ];
  assert.equal(dnsState(zones[0], accounts, observations), 'current');
  assert.equal(dnsState(zones[1], accounts, observations), 'other');
  assert.equal(
    dnsState(zones[1], accounts, [{ ...observations[0], error: 'DNS failed' }]),
    'unverified',
  );
  assert.equal(freshDns({ ...observations[0], checkedAt: '2000-01-01T00:00:00Z' }), false);
});
test('NS identity and domain associations respect suffix boundaries and uncertainty', () => {
  assert.equal(nsProvider(['ns1.alidns.com.', 'ns2.alidns.com.']), 'aliyun');
  assert.equal(nsProvider(['neil.ns.cloudflare.com', 'ns1.alidns.com']), null);
  assert.equal(nsProvider(['ns.cloudflare.com.attacker.test']), null);
  assert.equal(nsProvider([]), null);
  assert.equal(domainName('*.EXAMPLE.COM.'), 'example.com');
  assert.equal(belongsToDomain('www.example.co.uk', 'example.co.uk', ['example.co.uk']), true);
  assert.equal(belongsToDomain('example.com.attacker.test', 'example.com', ['example.com']), false);
  assert.equal(
    belongsToDomain('www.child.example.com', 'example.com', ['example.com', 'child.example.com']),
    false,
  );
});
test('resource aggregation retains same-named resources on different clouds and coalesces repeated observations only', () => {
  const all: ResourceSnapshot[] = [
    {
      account_id: 'cf',
      kind: 'certificates:zone-one',
      updated_at: at,
      data: [{ id: 'cert', domain: 'example.com', status: 'active' }],
    },
    {
      account_id: 'cf',
      kind: 'certificates:zone-two',
      updated_at: '2000-01-01',
      data: [{ id: 'cert', domain: 'example.com', status: 'old' }],
    },
    {
      account_id: 'ali',
      kind: 'certificates',
      updated_at: at,
      data: [{ id: 'cert', domain: 'example.com', status: 'active' }],
    },
  ];
  assert.equal(resourceRows(all, 'certificates').length, 2);
  assert.equal(
    resourceRows(all, 'certificates').find((r) => r.accountId === 'cf').status,
    'active',
  );
  const records = all.map((s) => ({ ...s, kind: s.kind.replace('certificates', 'records') }));
  assert.equal(resourceRows(records, 'records').length, 3);
});
test('public NS lookup sends no cloud credentials, ignores unrelated records and fails closed on DNS errors', async () => {
  const result = await observeDns('example.com', async (input, init) => {
    assert.equal(new URL(String(input)).hostname, 'cloudflare-dns.com');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    assert.equal(init?.redirect, 'manual');
    return Response.json({
      Status: 0,
      Answer: [
        { name: 'example.com.', type: 2, data: 'neil.ns.cloudflare.com.' },
        { name: 'attacker.test.', type: 2, data: 'ns1.alidns.com.' },
      ],
    });
  });
  assert.equal(result.provider, 'cloudflare');
  assert.equal(result.nameservers.length, 1);
  const failed = await observeDns('example.com', async () => Response.json({ Status: 2 }));
  assert.ok(failed.error);
  assert.equal(failed.provider, null);
});
test('all provider inventory adapters advance through pages and preserve domain binding evidence', async () => {
  const cf = new Cloud(
    'cloudflare',
    { apiToken: 'test-token', accountId: 'account' },
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/registrations')) {
        assert.equal(url.searchParams.get('cursor'), 'opaque-cursor');
        return Response.json({
          success: true,
          result: [{ domain_name: 'example.com', status: 'active', auto_renew: true }],
          result_info: { cursor: '' },
        });
      }
      assert.ok(url.pathname.endsWith('/pages/projects'));
      assert.equal(url.searchParams.get('page'), '2');
      return Response.json({
        success: true,
        result: [{ name: 'project', domains: ['www.example.com'] }],
        result_info: { total_pages: 3 },
      });
    },
  );
  assert.equal((await cf.registrations(2, 'opaque-cursor')).items[0].name, 'example.com');
  const services = await cf.servicesPage(2);
  assert.equal(services.nextCursor, 3);
  assert.deepEqual(services.items[0].domains, ['www.example.com']);
  const tc = new Cloud(
    'tencent',
    { secretId: 'test', secretKey: 'test', workspaceId: 'zone' },
    async (input, init) => {
      assert.equal(new URL(String(input)).hostname, 'teo.tencentcloudapi.com');
      assert.equal(JSON.parse(JSON.parse(String(init?.body)).Payload).Offset, 100);
      return Response.json({
        Response: {
          Result: JSON.stringify({
            Data: { Projects: [{ ProjectId: 'p', Name: 'Project' }], TotalCount: 201 },
          }),
        },
      });
    },
  );
  assert.equal((await tc.servicesPage(2)).nextCursor, 3);
  const ali = new Cloud(
    'aliyun',
    { accessKeyId: 'test', accessKeySecret: 'test' },
    async (input) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'domain.aliyuncs.com');
      assert.equal(url.searchParams.get('Action'), 'QueryDomainList');
      assert.equal(url.searchParams.get('PageNum'), '2');
      return Response.json({
        Data: {
          Domain: [
            {
              DomainName: 'example.com',
              Registrar: '阿里云',
              DnsList: { DnsList: ['neil.ns.cloudflare.com'] },
            },
          ],
        },
        NextPage: true,
      });
    },
  );
  const registration = await ali.registrations(2);
  assert.equal(registration.nextCursor, 3);
  assert.equal(registration.items[0].registrar, '阿里云');
});
