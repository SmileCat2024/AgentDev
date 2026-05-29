/**
 * 测试 open.bigmodel.cn 的 DNS 缓存和 fetch
 * 这是用户实际遇到的 ENOTFOUND 域名
 */

import dns from 'node:dns';

// DNS 缓存
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

dns.lookup = cachedLookup;

async function test() {
  // 测试 1: DNS 解析
  console.log('=== 测试 open.bigmodel.cn DNS 解析 ===');
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('DNS timeout')), 10000);
      dns.lookup('open.bigmodel.cn', (err, address, family) => {
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve({ address, family });
      });
    });
    console.log('DNS 解析成功:', result);
    console.log('缓存条目:', dnsCache.size);
  } catch (err) {
    console.error('DNS 解析失败:', err.message);
    console.log('这可能是网络/代理问题，继续测试...');
  }

  // 测试 2: 第二次 DNS（应命中缓存）
  console.log('\n=== 测试缓存命中 ===');
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Cached lookup timeout')), 5000);
      dns.lookup('open.bigmodel.cn', (err, address, family) => {
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve({ address, family });
      });
    });
    console.log('缓存命中:', result);
  } catch (err) {
    console.error('缓存 lookup 失败:', err.message);
  }

  // 测试 3: fetch 到 API
  console.log('\n=== 测试 fetch 到 open.bigmodel.cn ===');
  try {
    const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-4',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(15000),
    });
    console.log(`  状态: ${resp.status}`);
    const text = await resp.text();
    console.log(`  响应: ${text.substring(0, 200)}`);
    if (resp.status === 401) {
      console.log('✓ 网络连通（401 是因为没给 API key，说明请求到达了服务器）');
    }
  } catch (err) {
    console.error(`  fetch 失败: ${err.message}`);
    if (err.cause) console.error(`  原因: ${err.cause.message}`);
  }

  // 测试 4: 多次快速 fetch（模拟 Agent 运行场景）
  console.log('\n=== 测试连续 5 次 fetch ===');
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

  console.log('\n=== 测试完成 ===');
}

test().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
