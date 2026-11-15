import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cloud } from '../src/server/providers';
import { resourceRows } from '../src/inventory';

test('CVM lists available regions and queries instances with signed regional headers and pagination', async () => {
  const cloud = new Cloud(
    'tencent',
    { secretId: 'fixture-id', secretKey: 'fixture-secret' },
    async (input, init) => {
      assert.equal(new URL(String(input)).hostname, 'cvm.tencentcloudapi.com');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('X-TC-Version'), '2017-03-12');
      assert.ok(headers.get('Authorization')?.startsWith('TC3-HMAC-SHA256'));
      const action = headers.get('X-TC-Action');
      if (action === 'DescribeRegions')
        return Response.json({
          Response: {
            RegionSet: [
              { Region: 'ap-guangzhou', RegionName: '广州', RegionState: 'AVAILABLE' },
              { Region: 'ap-closed', RegionState: 'UNAVAILABLE' },
            ],
          },
        });
      assert.equal(action, 'DescribeInstances');
      assert.equal(headers.get('X-TC-Region'), 'ap-guangzhou');
      assert.equal(JSON.parse(String(init?.body)).Offset, 100);
      return Response.json({
        Response: {
          TotalCount: 201,
          InstanceSet: [
            {
              InstanceId: 'ins-test',
              InstanceName: 'Test',
              CPU: 2,
              Memory: 4,
              InstanceState: 'RUNNING',
              PublicIpAddresses: ['192.0.2.1'],
              PrivateIpAddresses: ['10.0.0.1'],
              Placement: { Zone: 'ap-guangzhou-1' },
              UserData: 'never-return',
            },
          ],
        },
      });
    },
  );
  assert.equal((await cloud.regions()).length, 1);
  const page = await cloud.serversPage('ap-guangzhou', 2);
  assert.equal(page.nextCursor, 3);
  assert.equal(page.items[0].memoryMiB, 4096);
  assert.ok(!JSON.stringify(page.items).includes('never-return'));
});
test('ECS uses read-only regional queries, opaque page tokens and reports registration-independent server details', async () => {
  const cloud = new Cloud(
    'aliyun',
    { accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret' },
    async (input) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'ecs.aliyuncs.com');
      assert.equal(url.searchParams.get('Version'), '2014-05-26');
      if (url.searchParams.get('Action') === 'DescribeRegions')
        return Response.json({
          Regions: { Region: [{ RegionId: 'cn-hangzhou', LocalName: '杭州' }] },
        });
      assert.equal(url.searchParams.get('Action'), 'DescribeInstances');
      assert.equal(url.searchParams.get('RegionId'), 'cn-hangzhou');
      assert.equal(url.searchParams.get('NextToken'), 'next-page');
      return Response.json({
        NextToken: 'another-page',
        Instances: {
          Instance: [
            {
              InstanceId: 'i-test',
              InstanceName: 'ECS',
              Cpu: 4,
              Memory: 8192,
              Status: 'Running',
              OSName: 'Linux',
              PublicIpAddress: { IpAddress: [] },
              EipAddress: { IpAddress: '192.0.2.2' },
              VpcAttributes: { PrivateIpAddress: { IpAddress: ['10.0.0.2'] } },
              KeyPairName: 'do-not-return',
            },
          ],
        },
      });
    },
  );
  assert.equal((await cloud.regions())[0].id, 'cn-hangzhou');
  const result = await cloud.serversPage('cn-hangzhou', 2, 'next-page');
  assert.equal(result.nextCursor, 3);
  assert.equal(result.providerCursor, 'another-page');
  assert.deepEqual(result.items[0].publicIps, ['192.0.2.2']);
  assert.ok(!JSON.stringify(result.items).includes('do-not-return'));
  await assert.rejects(() => cloud.serversPage('https://arbitrary.example'), /地域/);
});
test('server aggregation retains distinct regions and accounts with the same instance identifier', () => {
  const snapshots = ['cn-hangzhou', 'cn-shanghai'].map((region) => ({
    account_id: 'ali',
    kind: 'servers:' + region,
    updated_at: new Date().toISOString(),
    data: [{ id: 'same', region, name: 'instance' }],
  }));
  assert.equal(resourceRows(snapshots, 'servers').length, 2);
});
