/**
 * 验证 Undici fetch 是否使用 dns.lookup
 */

import dns from 'node:dns';

let lookupCalled = 0;
const originalLookup = dns.lookup;

// 包装 dns.lookup 来追踪调用
dns.lookup = function(...args) {
  const hostname = args[0];
  const isCallback = typeof args[1] === 'function' || typeof args[2] === 'function';
  if (isCallback) lookupCalled++;
  console.log(`[dns.lookup called] hostname=${hostname}, callCount=${lookupCalled}`);
  return originalLookup.apply(dns, args);
};

async function test() {
  console.log('=== 直接 dns.lookup 测试 ===');
  try {
    await new Promise((resolve, reject) => {
      dns.lookup('open.bigmodel.cn', (err, addr) => {
        if (err) reject(err); else resolve(addr);
      });
    });
  } catch (err) {
    console.log('dns.lookup 失败:', err.message);
  }
  console.log('dns.lookup 调用次数:', lookupCalled);

  console.log('\n=== fetch 测试 ===');
  lookupCalled = 0;
  try {
    const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
      signal: AbortSignal.timeout(15000),
    });
    console.log('fetch 状态:', resp.status);
  } catch (err) {
    console.log('fetch 失败:', err.message);
  }
  console.log('fetch 期间 dns.lookup 调用次数:', lookupCalled);

  console.log('\n=== fetch httpbin 测试 ===');
  lookupCalled = 0;
  try {
    const resp = await fetch('https://httpbin.org/get', {
      signal: AbortSignal.timeout(15000),
    });
    console.log('fetch 状态:', resp.status);
  } catch (err) {
    console.log('fetch 失败:', err.message);
  }
  console.log('fetch 期间 dns.lookup 调用次数:', lookupCalled);
}

test().catch(err => console.error('异常:', err));
