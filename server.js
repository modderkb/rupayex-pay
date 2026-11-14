require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const RUPayX_BASE = 'https://rupayex.net/api';
const USER_TOKEN = process.env.RUPAYEX_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SUCCESS_REDIRECT = 'https://serverhtml.netlify.app/';

const paidOrders = new Set();
const orderStatus = new Map();
const orderAmounts = new Map();

// Helper: API response se paid status nikaalein
function extractPaidStatus(data) {
  if (!data) return { paid: false, raw: '' };
  const candidates = [
    data.status,
    data.result?.status,
    data.data?.status,
    data.payment_status,
    data.data?.payment_status,
    data.order_status,
    data.data?.order_status,
  ];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const s = String(c).toLowerCase().trim();
    if (['success', 'paid', 'completed', 'captured'].includes(s)) {
      return { paid: true, raw: s };
    }
    if (s) return { paid: false, raw: s };
  }
  return { paid: false, raw: '' };
}

// ------------------------------------------------------------
// Middleware: paid user ko payment page na dikhayein
// ------------------------------------------------------------
app.use((req, res, next) => {
  if (
    req.method === 'GET' &&
    !req.path.startsWith('/api') &&
    !req.path.startsWith('/payment-callback') &&
    !req.path.startsWith('/payment-pending') &&
    !req.path.startsWith('/payment-waiting') &&
    !req.path.includes('.')
  ) {
    const paidCookie = req.cookies.paid_order;
    if (paidCookie && paidOrders.has(paidCookie)) {
      return res.redirect(SUCCESS_REDIRECT);
    }
  }
  next();
});

// ------------------------------------------------------------
// Create order
// ------------------------------------------------------------
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount = 499, customer_mobile = '' } = req.body;
    const amt = Number(amount);
    if (isNaN(amt) || amt < 1 || amt > 100000) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const paidCookie = req.cookies.paid_order;
    if (paidCookie && paidOrders.has(paidCookie)) {
      return res.json({ success: true, already_paid: true, redirect_url: SUCCESS_REDIRECT });
    }

    const order_id = 'ORD' + Date.now() + crypto.randomBytes(3).toString('hex');
    const redirect_url = `${BASE_URL}/payment-callback?order_id=${order_id}`;

    const payload = {
      user_token: USER_TOKEN,
      amount: amt,
      order_id,
      redirect_url,
      customer_mobile,
      remark1: 'Website Payment',
    };

    const response = await axios.post(`${RUPayX_BASE}/create-order`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    const data = response.data;
    if (data.status !== true && data.status !== 'success') {
      return res.status(400).json({ error: data.message || 'Order creation failed' });
    }

    orderStatus.set(order_id, 'pending');
    orderAmounts.set(order_id, amt);

    res.json({
      success: true,
      order_id,
      payment_url: data.payment_url || data.url || data.data?.payment_url,
      qr_code: data.qr_code || data.data?.qr_code || null,
    });
  } catch (err) {
    console.error('Create order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment gateway error' });
  }
});

// ------------------------------------------------------------
// Waiting page — UTR submit ke baad yahan aayenge
// ------------------------------------------------------------
app.get('/payment-waiting', (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.redirect('/');
  if (paidOrders.has(order_id)) return res.redirect(302, SUCCESS_REDIRECT);

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Status</title>
      <style>
        body { font-family: 'Segoe UI', sans-serif; text-align: center; padding: 50px 20px; background: #05050a; color: #fff; margin: 0; }
        .box { background: #0f172a; padding: 40px; border-radius: 20px; max-width: 400px; margin: auto; border: 1px solid rgba(255,255,255,0.1); }
        h1 { font-size: 22px; margin-bottom: 10px; }
        p { color: #94a3b8; font-size: 14px; }
        .spinner { border: 4px solid rgba(255,255,255,0.1); border-top: 4px solid #9333ea; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .status-pending { color: #fbbf24; }
        .status-failed { color: #f87171; }
        .status-success { color: #34d399; }
        .btn { background: linear-gradient(90deg, #9333ea, #ec4899); color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; display: none; margin-top: 15px; border: none; cursor: pointer; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="box">
        <div class="spinner" id="spinner"></div>
        <h1 id="title">⏳ Payment Verify Ho Raha Hai</h1>
        <p>Order ID: <b>${order_id}</b></p>
        <p>Status: <span id="status-text" class="status-pending">Checking...</span></p>
        <p id="message">Aapka payment check kiya ja raha hai, please wait...</p>
        <button id="retry-btn" class="btn" onclick="retryPayment()">Retry Payment</button>
      </div>
      <script>
        const orderId = "${order_id}";
        let attempts = 0;
        const MAX_ATTEMPTS = 100;
        let isRetrying = false;

        async function checkStatus() {
          if (isRetrying) return;
          attempts++;
          if (attempts > MAX_ATTEMPTS) {
            document.getElementById('status-text').textContent = 'Timeout';
            document.getElementById('message').textContent = 'Verification timeout. Please refresh the page.';
            document.getElementById('spinner').style.display = 'none';
            return;
          }
          try {
            const res = await fetch('/api/check-status?order_id=' + encodeURIComponent(orderId));
            const data = await res.json();
            const statusEl = document.getElementById('status-text');
            
            statusEl.textContent = data.status || 'pending';
            
            if (data.redirect) {
              statusEl.className = 'status-success';
              document.getElementById('title').textContent = '✅ Payment Success';
              document.getElementById('message').textContent = 'Redirecting...';
              window.location.href = data.redirect;
              return;
            }
            
            if (data.status === 'failed') {
              statusEl.className = 'status-failed';
              document.getElementById('title').textContent = '❌ Payment Failed';
              document.getElementById('message').textContent = 'Payment failed. Please retry.';
              document.getElementById('spinner').style.display = 'none';
              document.getElementById('retry-btn').style.display = 'inline-block';
              return;
            }
            
            setTimeout(checkStatus, 3000);
          } catch (e) {
            setTimeout(checkStatus, 3000);
          }
        }

        async function retryPayment() {
          isRetrying = true;
          document.getElementById('retry-btn').disabled = true;
          document.getElementById('retry-btn').textContent = 'Creating new order...';
          
          try {
            const res = await fetch('/api/retry-payment?order_id=' + encodeURIComponent(orderId));
            const data = await res.json();
            if (data.payment_url) {
              window.location.href = data.payment_url;
            } else {
              document.getElementById('message').textContent = 'Retry failed. Please refresh.';
            }
          } catch (e) {
            document.getElementById('message').textContent = 'Retry failed. Please refresh.';
          }
        }

        checkStatus();
      </script>
    </body>
    </html>
  `);
});

// ------------------------------------------------------------
// Status check API
// ------------------------------------------------------------
app.get('/api/check-status', async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.json({ status: 'invalid' });

  if (paidOrders.has(order_id)) {
    return res.json({ status: 'paid', redirect: SUCCESS_REDIRECT });
  }

  try {
    const check = await axios.get(`${RUPayX_BASE}/order-status`, {
      params: { user_token: USER_TOKEN, order_id },
      timeout: 10000,
    });

    const gw = String(
      check.data?.status ?? check.data?.data?.status ?? check.data?.result?.status ?? ''
    ).toUpperCase();

    if (['SUCCESS', 'PAID', 'COMPLETED', 'CAPTURED'].includes(gw)) {
      paidOrders.add(order_id);
      orderStatus.set(order_id, 'paid');
      res.cookie('paid_order', order_id, {
        httpOnly: true, sameSite: 'lax', maxAge: 365*24*60*60*1000,
      });
      return res.json({ status: 'paid', redirect: SUCCESS_REDIRECT });
    }

    if (['FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(gw)) {
      orderStatus.set(order_id, 'failed');
      return res.json({ status: 'failed' });
    }

    res.json({ status: gw.toLowerCase() || 'pending' });
  } catch (err) {
    console.error('Check status error:', err.message);
    res.json({ status: 'pending' });
  }
});

// ------------------------------------------------------------
// Retry payment API — naya order banata hai
// ------------------------------------------------------------
app.get('/api/retry-payment', async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.json({ error: 'order_id required' });

  try {
    const amt = orderAmounts.get(order_id) || 499;
    const newOrderId = 'ORD' + Date.now() + crypto.randomBytes(3).toString('hex');
    const redirect_url = `${BASE_URL}/payment-callback?order_id=${newOrderId}`;

    const payload = {
      user_token: USER_TOKEN,
      amount: amt,
      order_id: newOrderId,
      redirect_url,
      remark1: 'Retry Payment',
    };

    const createRes = await axios.post(`${RUPayX_BASE}/create-order`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    const paymentUrl = createRes.data?.payment_url || createRes.data?.url || createRes.data?.data?.payment_url;
    if (paymentUrl) {
      orderStatus.set(newOrderId, 'pending');
      orderAmounts.set(newOrderId, amt);
      return res.json({ payment_url: paymentUrl });
    }
    res.json({ error: 'Could not create new order' });
  } catch (err) {
    console.error('Retry payment error:', err.response?.data || err.message);
    res.json({ error: 'Retry failed' });
  }
});

// ------------------------------------------------------------
// Payment callback (RupayEx POST)
// ------------------------------------------------------------
app.post('/payment-callback', async (req, res) => {
  const { order_id } = req.body || {};
  console.log(`[callback POST] received:`, JSON.stringify(req.body));

  if (!order_id) return res.redirect('/payment-pending');
  if (paidOrders.has(order_id)) return res.redirect(302, SUCCESS_REDIRECT);

  return res.redirect(`/payment-waiting?order_id=${encodeURIComponent(order_id)}`);
});

// ------------------------------------------------------------
// GET fallback — browser test ya GET callback
// ------------------------------------------------------------
app.get('/payment-callback', (req, res) => {
  const { order_id } = req.query;
  console.log(`[callback GET] received:`, JSON.stringify(req.query));

  if (!order_id) return res.redirect('/payment-pending');
  if (paidOrders.has(order_id)) return res.redirect(302, SUCCESS_REDIRECT);

  return res.redirect(`/payment-waiting?order_id=${encodeURIComponent(order_id)}`);
});

// ------------------------------------------------------------
// Pending page
// ------------------------------------------------------------
app.get('/payment-pending', (req, res) => {
  const { order_id } = req.query;
  if (order_id && paidOrders.has(order_id)) {
    return res.redirect(302, SUCCESS_REDIRECT);
  }
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Payment Pending</title>
    <style>body{font-family:sans-serif;text-align:center;padding:50px 20px;background:#05050a;color:#fff;margin:0}.box{background:#0f172a;padding:40px;border-radius:20px;max-width:400px;margin:auto}h1{font-size:24px;color:#f87171}p{color:#94a3b8;font-size:14px}.btn{background:linear-gradient(90deg,#9333ea,#ec4899);color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;display:inline-block;margin-top:15px}</style>
    </head>
    <body><div class="box"><h1>⏳ Payment Pending</h1><p>Aapka payment abhi complete nahi hua.</p><a href="/" class="btn">Try Again</a></div></body>
    </html>
  `);
});

// ------------------------------------------------------------
// Webhook backup
// ------------------------------------------------------------
app.post('/payment-webhook', (req, res) => {
  const body = req.body || {};
  console.log('[webhook] received:', JSON.stringify(body));
  
  const order_id = body.order_id || body.data?.order_id || '';
  const parsed = extractPaidStatus(body);
  
  if (order_id && parsed.paid) {
    paidOrders.add(order_id);
    orderStatus.set(order_id, 'paid');
  }
  res.json({ status: 'ok' });
});

// ------------------------------------------------------------
// Debug endpoint
// ------------------------------------------------------------
app.get('/api/order-status/:order_id', (req, res) => {
  const { order_id } = req.params;
  res.json({
    order_id,
    status: orderStatus.get(order_id) || 'unknown',
    paid: paidOrders.has(order_id),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`Server running on ${BASE_URL}`)
);
