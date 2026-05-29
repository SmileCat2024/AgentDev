/**
 * http-client 独立测试 (纯 JS)
 * 测试 DNS 缓存 + fetch 的核心场景
 */

import dns from 'node:dns';

// ========== 复制 http-client.ts 的核心逻辑 ==========

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
    // 关键：必须异步回调
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

// ========== 测试 ==========

async function test() {
  console.log('=== Test 1: 基础 DNS lookup (callback) ===');
  
  const result1 = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 10000);
    dns.lookup('www.baidu.com', (err, address, family) => {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
  console.log('首次 lookup:', result1);
  console.log('DNS 缓存:', dnsCache.size, '条');
  
  console.log('\n=== Test 2: 缓存命中 DNS lookup ===');
  const result2 = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout (cached lookup hung!)')), 5000);
    dns.lookup('www.baidu.com', (err, address, family) => {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
  console.log('缓存 lookup:', result2);
  
  if (result1.address === result2.address) {
    console.log('✓ 缓存结果与首次一致');
  } else {
    console.error('✗ 缓存结果不一致!', result1.address, 'vs', result2.address);
  }

  console.log('\n=== Test 3: fetch 正常工作 ===');
  try {
    const resp = await fetch('https://www.baidu.com/', {
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    console.log(`  状态: ${resp.status}, 长度: ${text.length}`);
    if (resp.status === 200 && text.length > 0) {
      console.log('✓ fetch 正常');
    } else {
      console.error('✗ fetch 返回异常');
    }
  } catch (err) {
    console.error('✗ fetch 失败:', err.message);
  }

  console.log('\n=== Test 4: 多次 fetch (验证连接不卡死) ===');
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    try {
      const resp = await fetch('https://www.baidu.com/', {
        signal: AbortSignal.timeout(15000),
      });
      const text = await resp.text();
      console.log(`  第${i+1}次: ${resp.status}, ${text.length}B, ${Date.now()-start}ms`);
    } catch (err) {
      console.error(`  第${i+1}次失败: ${err.message}, ${Date.now()-start}ms`);
    }
  }

  console.log('\n=== Test 5: options.all=true 不缓存 ===');
  const allResult = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 10000);
    dns.lookup('www.baidu.com', { all: true }, (err, addresses) => {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(addresses);
    });
  });
  console.log('all=true 结果:', allResult);

  console.log('\n=== 所有测试完成 ===');
}

test().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
