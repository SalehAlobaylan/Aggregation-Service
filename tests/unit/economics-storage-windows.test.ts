import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ config:{cloudflareAccountId:'account',cloudflareApiToken:'test-token',cloudflareR2BucketName:'media'},receiver:vi.fn(),write:vi.fn() }));
vi.mock('../../src/config/index.js',()=>({config:mocks.config}));
vi.mock('../../src/cms/client.js',()=>({cmsClient:{getEconomicsCollection:mocks.receiver,writeOpMetrics:mocks.write}}));
vi.mock('../../src/observability/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn()}}));
import { pullOnce } from '../../src/services/cloudflare-analytics.service.js';
describe('provider storage window evidence',()=>{
 beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T12:30:00Z'));mocks.receiver.mockReset().mockResolvedValue({environment:'unmapped',tenant_id:'a',storage_window_version:1,storage_missing_hours:['2026-10-16T08:00:00Z']});mocks.write.mockReset().mockResolvedValue({success:true,written:2});});
 afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
 it('replays stable bounded UTC windows and keeps free/unknown operations separate',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>new Response(JSON.stringify({data:{viewer:{accounts:[{r2OperationsAdaptiveGroups:[{dimensions:{actionType:'DeleteObject'},sum:{requests:5}},{dimensions:{actionType:'FutureOperation'},sum:{requests:2}}]}]}}}))));
  await pullOnce();await pullOnce();
  expect(mocks.write).toHaveBeenCalledTimes(6);
  expect(mocks.write.mock.calls[0][0]).toEqual(mocks.write.mock.calls[3][0]);
  expect(mocks.write.mock.calls[0][0]).toMatchObject({tenant_id:'a',window_key:'account/media',window_start:'2026-10-16T08:00:00.000Z',window_end:'2026-10-16T09:00:00.000Z',items:[{op_class:'F',count:5},{op_class:'U',count:2}]});
 });
 it('does not publish unavailable provider scope as a known-zero window',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>new Response(JSON.stringify({data:{viewer:{accounts:[]}}}))));
  await pullOnce();expect(mocks.write).not.toHaveBeenCalled();
 });
 it('waits for durable receiver capability before any provider request',async()=>{
  mocks.receiver.mockResolvedValue({storage_window_version:0});const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await pullOnce();expect(fetch).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
 });
});
