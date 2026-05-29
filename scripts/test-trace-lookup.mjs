/**
 * 追踪 Undici 内部 dns.lookup 调用的实际参数格式
 */

import dns from 'node:dns';

const originalLookup = dns.lookup;

dns.lookup = function(...args) {
  const hostname = args[0];
  const optionsArg = args[1];
  const callbackArg = args[2];
  
  console.log(`\n[dns.lookup] hostname=${hostname}`);
  console.log(`  arg1 type: ${typeof optionsArg}`, typeof optionsArg === 'object' ? JSON.stringify(optionsArg) : '');
  console.log(`  arg2 type: ${typeof callbackArg}`);
  
  // 用 callback 包装来追踪回调参数
  if (typeof optionsArg === 'function') {
    // lookup(hostname, callback)
    return originalLookup.call(dns, hostname, (err, ...cbArgs) => {
      console.log(`  [callback] err=${err?.message || err}, args:`, cbArgs.map(a => typeof a === 'object' ? JSON.stringify(a) : a));
      optionsArg(err, ...cbArgs);
    });
  } else if (typeof callbackArg === 'function') {
    // lookup(hostname, options, callback)
    return originalLookup.call(dns, hostname, optionsArg, (err, ...cbArgs) => {
      console.log(`  [callback] err=${err?.message || err}, args:`, cbArgs.map(a => typeof a === 'object' ? JSON.stringify(a) : a));
      callbackArg(err, ...cbArgs);
    });
  } else {
    // Promise mode
    return originalLookup.apply(dns, args);
  }
};

async function test() {
  console.log('=== fetch open.bigmodel.cn ===');
  try {
    const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
      signal: AbortSignal.timeout(15000),
    });
    console.log('\nfetch 状态:', resp.status);
  } catch (err) {
    console.log('\nfetch 失败:', err.message);
  }
}

test().catch(err => console.error('异常:', err));
