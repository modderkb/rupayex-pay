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
// Waiting page (UTR submit ke baad yahan aayenge, polling karein)
// ------------------------------------------------------------
app.get('/payment-waiting', (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.redirect('/');

  // Agar already paid hai to direct redirect
  if (paidOrders.has(order_id)) {
    return res.redirect(302, SUCCESS_REDIRECT);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Checking</title>
      <style>
        body { font-family: 'Segoe UI', sans-serif; text-align: center; padding: 50px 20px; background: #05050a; color: #fff; margin: 0; }
        .box { background: #0f172a; padding: 40px; border-radius: 20px; max-width: 400px; margin: auto; border: 1px solid rgba(255,255,255,0.1); }
        h1 { font-size: 22px; margin-bottom: 10px; color: #fbbf24; }
        p { color: #94a3b8; font-size: 14px; }
        .spinner { border: 4px solid rgba(255,255,255,0.1); border-top: 4px solid #9333ea; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .status { font-weight: bold; color: #fbbf24; }
      </style>
    </head>
    <body>
      <div class="box">
        <div class="spinner"></div>
        <h1>⏳ Payment Verify Ho Raha Hai</h1>
        <p>Order ID: <b>${order_id}</b></p>
        <p>Status: <span class="status" id="status-text">Checking...</span></p>
        <p>Aapka payment check kiya ja raha hai, please wait...</p>
      </div>
      <script>
        const orderId = "${order_id}";
        let attempts = 0;
        const MAX_ATTEMPTS = 60; // ~3 minutes (3s interval)
        
        async function checkStatus() {
          attempts++;
          if (attempts > MAX_ATTEMPTS) {
            document.getElementById('status-text').textContent = 'Timeout';
            return;
          }
          try {
            const res = await fetch('/api/check-status?order_id=' + encodeURIComponent(orderId));
            const data = await res.json();
            document.getElementById('status-text').textContent = data.status || 'pending';
            
            if (data.redirect) {
              window.location.href = data.redirect;
              return;
            }
            if (data.new_payment_url) {
              window.location.href = data.new_payment_url;
              return;
            }
            // Pending: 3 second baad phir check karein
            setTimeout(checkStatus, 3000);
          } catch (e) {
            setTimeout(checkStatus, 3000);
          }
        }
        checkStatus();
      </script>
    </body>
    </html>
  `);
});

// ------------------------------------------------------------
// API: Status check (waiting page se call hoga)
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

    if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(gw)) {
      // Failed: naya order banayein
      const newOrderId = 'ORD' + Date.now() + crypto.randomBytes(3).toString('hex');
      const redirect_url = `${BASE_URL}/payment-callback?order_id=${newOrderId}`;
      
      const payload = {
        user_token: USER_TOKEN,
        amount: 499, // Ya jo bhi amount ho
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
        return res.json({ status: 'failed', new_payment_url: paymentUrl });
      }
      return res.json({ status: 'failed', redirect: '/' }); // Fallback
    }

    // Pending: wahi page par wait karein
    res.json({ status: gw.toLowerCase() || 'pending' });
  } catch (err) {
    console.error('Check status error:', err.message);
    res.json({ status: 'pending' }); // Error par bhi pending maanein, polling jari
  }
});

// ------------------------------------------------------------
// Payment callback (RupayEx yahan bhejta hai)
// ------------------------------------------------------------
app.post('/payment-callback', async (req, res) => {
  const { order_id, status } = req.body || {};
  if (!order_id) return res.redirect('/payment-pending');

  if (paidOrders.has(order_id)) {
    return res.redirect(302, SUCCESS_REDIRECT);
  }

  // Callback body ka status sirf reference ke liye, API se verify karein
  try {
    const check = await axios.get(`${RUPayX_BASE}/order-status`, {
      params: { user_token: USER_TOKEN, order_id },
      timeout: 10000,
    });
    const gw = String(
      check.data?.status ?? check.data?.data?.status ?? ''
    ).toUpperCase();

    if (['SUCCESS', 'PAID', 'COMPLETED', 'CAPTURED'].includes(gw)) {
      paidOrders.add(order_id);
      orderStatus.set(order_id, 'paid');
      res.cookie('paid_order', order_id, {
        httpOnly: true, sameSite: 'lax', maxAge: 365*24*60*60*1000,
      });
      return res.redirect(302, SUCCESS_REDIRECT);
    }
    return res.redirect(`/payment-waiting?order_id=${encodeURIComponent(order_id)}`);
  } catch (err) {
    return res.redirect(`/payment-waiting?order_id=${encodeURIComponent(order_id)}`);
  }
});

// ------------------------------------------------------------
// Pending page
// ------------------------------------------------------------
app.get('/payment-pending', (req, res) => {
  const { order_id, status } = req.query;
  if (order_id && paidOrders.has(order_id)) {
    return res.redirect(302, SUCCESS_REDIRECT);
  }
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Payment Pending</title>
    <style>body{font-family:sans-serif;text-align:center;padding:50px 20px;background:#05050a;color:#fff;margin:0}.box{background:#0f172a;padding:40px;border-radius:20px;max-width:400px;margin:auto}h1{font-size:24px;color:#f87171}p{color:#94a3b8;font-size:14px}.btn{background:linear-gradient(90deg,#9333ea,#ec4899);color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;display:inline-block;margin-top:15px}</style>
    </head>
    <body><div class="box"><h1>⏳ Payment ${status || 'Pending'}</h1><p>Order ID: <b>${order_id || 'N/A'}</b></p><p>Aapka payment abhi complete nahi hua.</p><a href="/" class="btn">Try Again</a></div></body>
    </html>
  `);
});

// Webhook backup
app.post('/payment-webhook', (req, res) => {
  const body = req.body || {};
  const order_id = body.order_id || body.data?.order_id || '';
  const parsed = extractPaidStatus(body);
  if (order_id && parsed.paid) {
    paidOrders.add(order_id);
    orderStatus.set(order_id, 'paid');
  }
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on ${BASE_URL}`));
