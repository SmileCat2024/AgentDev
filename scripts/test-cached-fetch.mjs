/**
 * 完整模拟 AgentDev 的 http-client 初始化流程 + fetch 测试
 */

import dns from 'node:dns';

// ========== DNS 缓存（和 http-client.ts 相同的逻辑）==========

const dnsCache = new Map();
const DNS_CACHE_TTL_MS = 60000;
const _originalLookup = dns.lookup;

function cachedLookup(hostname, optionsOrCallback, callback) {
  let options = {};
  let cb;
  if (typeof optionsOrCallback === 'function') {
    cb = optionsOrCallback;
  } else if (optionsOrCallback) {
    options = optionsOrCallback;
    cb = callback;
  }
  if (!cb) return;
  if (options.all) {
    _originalLookup(hostname, options, cb);
    return;
  }
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > Date.now()) {
    process.nextTick(() => cb(null, cached.address, cached.family));
    return;
  }
  _originalLookup(hostname, options, (err, ...args) => {
    if (!err && typeof args[0] === 'string' && args[0]) {
      dnsCache.set(hostname, {
        address: args[0],
        family: typeof args[1] === 'number' ? args[1] : 4,
        expires: Date.now() + DNS_CACHE_TTL_MS,
      });
    }
    cb(err, ...args);
  });
}

// 覆写 dns.lookup
dns.lookup = cachedLookup;
console.log('✓ dns.lookup 已覆写为 cachedLookup');

// ========== 模拟 Undici Agent 设置（异步）==========

async function setupUndici() {
  try {
    const undici = await import('undici');
    const agent = new undici.Agent({
      keepAliveTimeout: 30000,
      keepAliveMaxTimeout: 300000,
      connections: 50,
      pipelining: 1,
    });
    undici.setGlobalDispatcher(agent);
    console.log('✓ Undici Agent 已设置 (keep-alive)');
  } catch (err) {
    console.log('⚠ Undici Agent 设置失败:', err.message);
  }
}

// ========== 测试 ==========

async function test() {
  // 等待 Undici Agent 设置完成
  await setupUndici();

  console.log('\n=== Test 1: 首次 fetch open.bigmodel.cn ===');
  const start1 = Date.now();
  try {
    const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    console.log(`  状态: ${resp.status}, ${Date.now()-start1}ms`);
    console.log(`  DNS 缓存: ${dnsCache.size} 条`);
    if (resp.status === 401) console.log('  ✓ 网络连通');
  } catch (err) {
    console.error(`  ✗ 失败: ${err.message} (${Date.now()-start1}ms)`);
    if (err.cause) console.error(`  原因: ${err.cause.message}`);
  }

  console.log('\n=== Test 2: 第二次 fetch (应命中 DNS 缓存) ===');
  const start2 = Date.now();
  try {
    const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    console.log(`  状态: ${resp.status}, ${Date.now()-start2}ms`);
  } catch (err) {
    console.error(`  ✗ 失败: ${err.message} (${Date.now()-start2}ms)`);
  }

  console.log('\n=== Test 3: 连续 5 次快速 fetch ===');
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    try {
      const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'glm-4', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
        signal: AbortSignal.timeout(15000),
      });
      await resp.text();
      console.log(`  第${i+1}次: ${resp.status}, ${Date.now()-start}ms`);
    } catch (err) {
      console.error(`  第${i+1}次失败: ${err.message}, ${Date.now()-start}ms`);
    }
  }

  console.log('\n=== 所有测试完成 ===');
  console.log('DNS 缓存最终状态:');
  for (const [hostname, entry] of dnsCache) {
    console.log(`  ${hostname} → ${entry.address}, TTL: ${entry.expires - Date.now()}ms`);
  }
}

test().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
