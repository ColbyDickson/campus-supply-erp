export const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]);
export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);
export const monthStart = () => `${utcDay().slice(0, 7)}-01`;
export function validateConnection(projectUrl, key) {
  let url;
  try { url = new URL(projectUrl); } catch { throw new Error('Enter the Supabase Project URL, beginning with https://.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use the HTTPS project root URL from Supabase, without a path or password.');
  }
  if (key.startsWith('sb_publishable_')) return { url: url.origin, key };
  try {
    const claims = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (claims.role === 'anon') return { url: url.origin, key };
  } catch { /* Show the same safe message for invalid or privileged keys. */ }
  throw new Error('Use the publishable key (sb_publishable_…) or legacy anon key. Never enter a secret or service_role key.');
}
export function cartTotals(cart, products, discount, rate) {
  const subtotal = Math.round(cart.reduce((sum, line) => sum + Number(products.find(p => p.id === line.product_id)?.price || 0) * line.quantity, 0) * 100) / 100;
  const tax = Math.round(Math.max(0, subtotal - discount) * Number(rate) * 100) / 100;
  return { subtotal, discount, tax, total: Math.round((subtotal - discount + tax) * 100) / 100 };
}
