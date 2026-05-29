/**
 * 测试 Claude Code 风格的 HTTP 客户端初始化
 * 验证 initHttpClient + setGlobalDispatcher + fetch 是否正常
 */

async function main() {
  console.log('=== 测试 Claude Code 风格 HTTP 客户端 ===\n');

  // 1. 直接导入 http-client 模块
  const { initHttpClient, getGlobalDispatcher } = await import('../dist/chunk-BNV6GER6.js');
  initHttpClient();
  console.log('✓ initHttpClient() called');

  const dispatcher = getGlobalDispatcher();
  console.log(`  dispatcher: ${dispatcher ? dispatcher.constructor.name : 'null'}`);

  // 2. 测试 Anthropic 适配器用的原生 fetch（Undici）
  console.log('\n--- 测试原生 fetch (Undici) → open.bigmodel.cn ---');
  try {
    const res1 = await fetch('https://open.bigmodel.cn/dev-api/compat-api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': 'Bearer test' },
      body: JSON.stringify({ model: 'glm-4', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    console.log(`  Status: ${res1.status} ${res1.statusText}`);
    const text1 = await res1.text();
    console.log(`  Response: ${text1.slice(0, 200)}`);
    console.log('✓ 第一次 fetch 正常工作');
  } catch (e) {
    console.error('✗ 第一次 fetch 失败:', e.message);
    // 即使 fetch 失败（如 403），只要不是 Invalid IP address 或卡死就算通过
  }

  // 3. 第二次 fetch（验证不卡死）
  console.log('\n--- 第二次 fetch（验证不卡死） ---');
  const start = Date.now();
  try {
    const res2 = await fetch('https://open.bigmodel.cn/dev-api/compat-api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': 'Bearer test' },
      body: JSON.stringify({ model: 'glm-4', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    const elapsed = Date.now() - start;
    console.log(`  Status: ${res2.status} ${res2.statusText} (${elapsed}ms)`);
    console.log('✓ 第二次 fetch 正常，不卡死');
  } catch (e) {
    const elapsed = Date.now() - start;
    console.error(`✗ 第二次 fetch 失败 (${elapsed}ms):`, e.message);
  }

  // 4. 测试 httpbin
  console.log('\n--- 测试 httpbin.org ---');
  try {
    const res3 = await fetch('https://httpbin.org/get');
    console.log(`  Status: ${res3.status} ${res3.statusText}`);
    console.log('✓ httpbin fetch 正常');
  } catch (e) {
    console.error('✗ httpbin fetch 失败:', e.message);
  }

  console.log('\n=== 测试完成 ===');
}

main().catch(e => {
  console.error('测试失败:', e);
  process.exit(1);
});
