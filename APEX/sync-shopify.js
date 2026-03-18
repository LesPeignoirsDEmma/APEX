// APEX — Shopify Sync Script (GitHub Actions)
// Lit les configs depuis le secret SHOPIFY_CONFIGS (JSON array)
// Fetch les données Shopify côté serveur (pas de CORS) pour 3 périodes
// Sauvegarde les résultats dans shopify-data.json

const https = require('https');
const fs = require('fs');

// ── HELPERS ──────────────────────────────────────────────────────────────────

function shopFetch(shop, token, path) {
  return new Promise((resolve) => {
    const url = `https://${shop}/admin/api/2024-01${path}`;
    const opts = {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function dateFrom(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

// ── CALCUL CRO POUR UNE BOUTIQUE + UNE PÉRIODE ───────────────────────────────

async function computeCRO(shop, token, period) {
  const from = dateFrom(period);
  const now = new Date();
  const fromDate = new Date(now - period * 24 * 60 * 60 * 1000);
  const mid = new Date(fromDate.getTime() + (now - fromDate) / 2).toISOString();

  const [ordData, prodData, checkoutData, custData] = await Promise.all([
    shopFetch(shop, token, `/orders.json?status=any&limit=250&created_at_min=${from}T00:00:00&fields=id,total_price,currency,created_at,financial_status,refund_total,line_items,customer,discount_codes,total_discounts`),
    shopFetch(shop, token, `/products.json?limit=250&fields=id,title,status,variants,created_at`),
    shopFetch(shop, token, `/checkouts.json?limit=250&created_at_min=${from}T00:00:00&fields=id,total_price,created_at,completed_at,line_items`),
    shopFetch(shop, token, `/customers.json?limit=250&created_at_min=${from}T00:00:00&fields=id,orders_count,total_spent,created_at,tags`)
  ]);

  const orders = (ordData && ordData.orders) || [];
  const products = (prodData && prodData.products) || [];
  const checkouts = (checkoutData && checkoutData.checkouts) || [];
  const customers = (custData && custData.customers) || [];

  // ── Revenue & commandes ──
  const paid = orders.filter(o => ['paid','partially_paid','partially_refunded'].includes(o.financial_status));
  const revenue = paid.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
  const aov = paid.length ? revenue / paid.length : 0;
  const currency = paid[0] ? paid[0].currency : 'EUR';

  // ── Remboursements ──
  const refunds = orders.filter(o => o.financial_status === 'refunded').length;
  const refundRate = orders.length ? Math.round(refunds / orders.length * 100) : 0;

  // ── Remises ──
  const discountOrders = paid.filter(o => o.discount_codes && o.discount_codes.length > 0).length;
  const discountRate = paid.length ? Math.round(discountOrders / paid.length * 100) : 0;
  const totalDiscounts = paid.reduce((s, o) => s + parseFloat(o.total_discounts || 0), 0);
  const discountShare = revenue ? Math.round(totalDiscounts / revenue * 100) : 0;

  // ── Tendance (1ère vs 2ème moitié) ──
  const half1 = paid.filter(o => new Date(o.created_at) < new Date(mid));
  const half2 = paid.filter(o => new Date(o.created_at) >= new Date(mid));
  const revenueHalf1 = half1.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
  const revenueHalf2 = half2.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);

  // ── Top produits ──
  const prodMap = {};
  paid.forEach(o => {
    (o.line_items || []).forEach(li => {
      const key = li.title || li.name || 'Inconnu';
      if (!prodMap[key]) prodMap[key] = { qty: 0, revenue: 0 };
      prodMap[key].qty += li.quantity || 1;
      prodMap[key].revenue += parseFloat(li.price || 0) * (li.quantity || 1);
    });
  });
  const topProducts = Object.entries(prodMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 10)
    .map(([name, d]) => ({ name, qty: d.qty, revenue: Math.round(d.revenue) }));
  const top3Revenue = topProducts.slice(0, 3).reduce((s, p) => s + p.revenue, 0);
  const top3RevenueShare = revenue ? Math.round(top3Revenue / revenue * 100) : 0;

  // ── Timing ──
  const hourly = {}, daily = {};
  paid.forEach(o => {
    const d = new Date(o.created_at);
    const h = d.getHours();
    const dw = d.getDay();
    hourly[h] = (hourly[h] || 0) + 1;
    daily[dw] = (daily[dw] || 0) + 1;
  });

  // ── Clients ──
  const customerIds = new Set();
  const returningIds = new Set();
  paid.forEach(o => {
    if (o.customer && o.customer.id) {
      if (customerIds.has(o.customer.id)) returningIds.add(o.customer.id);
      customerIds.add(o.customer.id);
    }
  });
  const newCust = customerIds.size - returningIds.size;
  const returning = returningIds.size;
  const returningOrders = paid.filter(o => o.customer && returningIds.has(o.customer.id));
  const avgOrdersPerRepeat = returningIds.size ? (returningOrders.length / returningIds.size).toFixed(1) : 0;

  // ── LTV & VIP ──
  let totalLTV = 0;
  customers.forEach(c => { totalLTV += parseFloat(c.total_spent || 0); });
  const avgLTV = customers.length ? Math.round(totalLTV / customers.length) : 0;
  const vipCustomers = customers.filter(c => parseInt(c.orders_count || 0) >= 3).length;

  // ── Abandon panier ──
  const abandonedCheckouts = checkouts.filter(c => !c.completed_at);
  const totalCheckouts = checkouts.length;
  const abandonedValue = abandonedCheckouts.reduce((s, c) => s + parseFloat(c.total_price || 0), 0);
  const abandonRate = totalCheckouts ? Math.round(abandonedCheckouts.length / totalCheckouts * 100) : null;
  const abandonMap = {};
  abandonedCheckouts.forEach(c => {
    (c.line_items || []).forEach(li => {
      const key = li.title || 'Inconnu';
      abandonMap[key] = (abandonMap[key] || 0) + 1;
    });
  });
  const topAbandoned = Object.entries(abandonMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // ── Produits sans vente ──
  const soldProductTitles = new Set(Object.keys(prodMap));
  const activeProducts = products.filter(p => p.status === 'active');
  const zeroSaleProducts = activeProducts
    .filter(p => !soldProductTitles.has(p.title))
    .map(p => p.title)
    .slice(0, 20);
  const totalProducts = activeProducts.length;

  // ── Nouveaux produits ──
  const newProductsAdded = products.filter(p => new Date(p.created_at) >= fromDate).length;

  return {
    period, revenue: Math.round(revenue), orders: paid.length, aov: Math.round(aov), currency,
    refunds, refundRate, revenueHalf1: Math.round(revenueHalf1), revenueHalf2: Math.round(revenueHalf2),
    discountOrders, discountRate, discountShare, totalDiscounts: Math.round(totalDiscounts),
    newCust, returning, avgOrdersPerRepeat, avgLTV, vipCustomers,
    topProducts, top3RevenueShare, hourly, daily,
    totalProducts, zeroSaleProducts, newProductsAdded,
    abandonedCheckouts: abandonedCheckouts.length, totalCheckouts, abandonRate,
    abandonedValue: Math.round(abandonedValue), topAbandoned,
    syncedAt: new Date().toISOString()
  };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const configRaw = process.env.SHOPIFY_CONFIGS;
  if (!configRaw) {
    console.error('❌ Secret SHOPIFY_CONFIGS manquant');
    process.exit(1);
  }

  let configs;
  try { configs = JSON.parse(configRaw); }
  catch(e) { console.error('❌ SHOPIFY_CONFIGS JSON invalide:', e.message); process.exit(1); }

  const result = { lastUpdated: new Date().toISOString(), boutiques: {} };

  for (const cfg of configs) {
    const { id, shop, token } = cfg;
    if (!id || !shop || !token) { console.warn(`⚠️ Config invalide:`, cfg); continue; }
    console.log(`🔄 Sync ${shop}...`);

    result.boutiques[id] = { finance: {}, cro: {} };

    // Finance (30 jours) pour la page Finances
    try {
      const fin = await computeCRO(shop, token, 30);
      result.boutiques[id].finance = {
        revenue: fin.revenue, orders: fin.orders, currency: fin.currency, syncedAt: fin.syncedAt
      };
    } catch(e) { console.error(`  ❌ Finance error:`, e.message); }

    // CRO pour les 3 périodes
    result.boutiques[id].cro = {};
    for (const period of [7, 30, 90]) {
      try {
        console.log(`  📊 Période ${period}j...`);
        result.boutiques[id].cro[period] = await computeCRO(shop, token, period);
      } catch(e) { console.error(`  ❌ CRO ${period}j error:`, e.message); }
    }

    console.log(`  ✅ ${shop} done`);
  }

  fs.writeFileSync('shopify-data.json', JSON.stringify(result, null, 2));
  console.log('✅ shopify-data.json saved');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
