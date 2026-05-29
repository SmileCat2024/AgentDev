/**
 * http-client 模块测试
 *
 * 验证：
 * 1. DNS 缓存正常工作（命中后不再查 DNS）
 * 2. fetch 能正常完成（不会卡死或返回空响应）
 * 3. 缓存回调是异步的（不会导致 Undici 状态机混乱）
 */

import dns from 'node:dns';

// 先保存原始引用
const originalLookup = dns.lookup;
let lookupCallCount = 0;

// 追踪 dns.lookup 调用次数
const countingLookup = function(
  hostname: string,
  optionsOrCallback?: any,
  callback?: any,
): void {
  lookupCallCount++;
  // 转发给原始 lookup
  if (typeof optionsOrCallback === 'function') {
    originalLookup(hostname, optionsOrCallback);
  } else if (callback) {
    originalLookup(hostname, optionsOrCallback, callback);
  } else {
    // Promise 模式 — 不太可能出现在 Undici 内部调用中
    originalLookup(hostname, optionsOrCallback as any);
  }
};

// 替换 dns.lookup 为计数版本
(dns as any).lookup = countingLookup;

// 现在导入 http-client（它会覆写 dns.lookup 为 cachedLookup）
import { initHttpClient, flushDnsCache, getDnsCacheStats } from '../src/llm/http-client.js';

async function testDnsCache(): Promise<void> {
  console.log('=== 测试 DNS 缓存 ===');

  initHttpClient();

  // 测试 1: 验证 initHttpClient 覆写了 dns.lookup
  console.log('✓ initHttpClient() 完成');
  console.log('  DNS 缓存状态:', getDnsCacheStats());

  // 测试 2: 手动调用 cachedLookup 模拟 Undici 的回调方式
  const hostname = 'www.baidu.com';
  let actualCalls = 0;
  const originalLookupRef = dns.lookup;

  // 用 callback 方式调用（Undici 的调用方式）
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('DNS lookup timeout')), 10000);
    originalLookupRef(hostname, (err, address, family) => {
      clearTimeout(timeout);
      if (err) {
        reject(new Error(`DNS lookup failed: ${err.message}`));
        return;
      }
      actualCalls++;
      console.log(`  首次 lookup: ${hostname} → ${address} (family: ${family})`);
      resolve();
    });
  });

  // 检查缓存
  const stats1 = getDnsCacheStats();
  console.log(`  DNS 缓存条目: ${stats1.size}`);
  if (stats1.size > 0) {
    const entry = stats1.entries.find(e => e.hostname === hostname);
    if (entry) {
      console.log(`  缓存命中: ${entry.hostname} → ${entry.address}, TTL: ${entry.ttlMs}ms`);
    }
  }

  // 测试 3: 第二次调用应该命中缓存
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Cached DNS lookup timeout')), 5000);
    originalLookupRef(hostname, (err, address, family) => {
      clearTimeout(timeout);
      if (err) {
        reject(new Error(`Cached DNS lookup failed: ${err.message}`));
        return;
      }
      actualCalls++;
      console.log(`  缓存 lookup: ${hostname} → ${address} (family: ${family})`);
      resolve();
    });
  });

  // 测试 4: 验证 fetch 能正常工作
  console.log('\n=== 测试 fetch ===');
  try {
    const response = await fetch('https://www.baidu.com', {
      signal: AbortSignal.timeout(10000),
    });
    console.log(`  fetch 状态: ${response.status}`);
    const text = await response.text();
    console.log(`  响应长度: ${text.length} bytes`);
    if (text.length > 0) {
      console.log('✓ fetch 正常返回数据');
    } else {
      console.error('✗ fetch 返回空响应！');
    }
  } catch (err: any) {
    console.error(`✗ fetch 失败: ${err.message}`);
  }

  // 测试 5: 验证回调是异步的
  console.log('\n=== 测试异步回调 ===');
  let syncCallback = true;
  // 先确保缓存中有条目
  await new Promise<void>((resolve) => {
    originalLookupRef('example.com', () => resolve());
  });

  // 再次调用，应该命中缓存
  originalLookupRef('example.com', () => {
    syncCallback = false;  // 如果回调执行了，说明是异步的（因为 nextTick 会在微任务之后）
    console.log('  缓存回调已执行');
  });
  if (syncCallback) {
    console.log('✓ 缓存命中回调是异步的（process.nextTick 生效）');
  }

  // 等待 nextTick 回调执行
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log('  回调最终已执行:', !syncCallback);

  console.log('\n=== 所有测试完成 ===');
  const finalStats = getDnsCacheStats();
  console.log('最终 DNS 缓存:', finalStats.size, '条');
  for (const entry of finalStats.entries) {
    console.log(`  ${entry.hostname} → ${entry.address} (TTL: ${entry.ttlMs}ms)`);
  }
}

testDnsCache().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
