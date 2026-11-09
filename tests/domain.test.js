import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotals, escapeHtml, validateConnection } from '../src/domain.js';
test('connection screen accepts public keys and rejects privileged keys or URL credentials', () => {
  assert.equal(validateConnection('https://example.supabase.co','sb_publishable_demo').url,'https://example.supabase.co');
  const jwt = role => `header.${btoa(JSON.stringify({role}))}.signature`;
  assert.equal(validateConnection('https://example.supabase.co',jwt('anon')).key,jwt('anon'));
  for (const key of ['sb_secret_demo',jwt('service_role'),'invalid']) {
    assert.throws(()=>validateConnection('https://example.supabase.co',key),/publishable key/);
  }
  assert.throws(()=>validateConnection('https://user:password@example.com','sb_publishable_demo'));
  assert.throws(()=>validateConnection('http://example.com','sb_publishable_demo'));
});
test('cart preview calculates multi-line totals, discount, and rounded tax', () => {
  assert.deepEqual(cartTotals([{product_id:'p',quantity:3},{product_id:'q',quantity:1}],
    [{id:'p',price:1},{id:'q',price:2.75}],1,0.0725),{subtotal:5.75,discount:1,tax:0.34,total:5.09});
});
test('database text is escaped before rendering into HTML', () => {
  assert.equal(escapeHtml('<script>"x" & \'y\'</script>'),'&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
});
