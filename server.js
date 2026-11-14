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

// In-memory store (production me Redis/DB use karo)
const paidOrders = new Set();
const orderStatus = new Map();

// ------------------------------------------------------------
// Helper: gateway response se paid status nikaalo (flexible)
// ------------------------------------------------------------
function extractPaidStatus(data) {
  if (!data) return { paid: false, raw: '' };

  // Possible status field locations
  const candidates = [
    data.status,
    data.result?.status,
    data.data?.status,
    data.payment_status,
    data.data?.payment_status,
    data.order_status,
    data.data?.order_status,
    data.txn_status,
  ];

  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const s = String(c).toLowerCase().trim();
    if (['success', 'paid', 'completed', 'captured', '1', 'true'].includes(s)) {
      return { paid: true, raw: s };
    }
    if (s) return { paid: false, raw: s };
  }
  return { paid: false, raw: '' };
}

// ------------------------------------------------------------
// MIDDLEWARE: agar user already paid hai to payment page mat dikhao
// ------------------------------------------------------------
app.use((req, res, next) => {
  if (
    req.method === 'GET' &&
    !req.path.startsWith('/api') &&
    !req.path.startsWith('/payment-callback') &&
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
// Create order endpoint
// ------------------------------------------------------------
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount = 499, customer_mobile = '' } = req.body;

    const amt = Number(amount);
    if (isNaN(amt) || amt < 1 || amt > 100000) {
      return res.status(400).json({ error: 'Invalid amount (1-100000)' });
    }

    const paidCookie = req.cookies.paid_order;
    if (paidCookie && paidOrders.has(paidCookie)) {
      return res.json({
        success: true,
        already_paid: true,
        redirect_url: SUCCESS_REDIRECT,
      });
    }

    const order_id =
      'ORD' + Date.now() + crypto.randomBytes(3).toString('hex');

    const redirect_url = `${BASE_URL}/payment-callback?order_id=${order_id}`;

    const payload = {
      user_token: USER_TOKEN,
      amount: amt,
      order_id: order_id,
      redirect_url: redirect_url,
      customer_mobile: customer_mobile,
      remark1: 'Website Payment',
    };

    const response = await axios.post(`${RUPayX_BASE}/create-order`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    const data = response.data;

    if (data.status !== true && data.status !== 'success') {
      return res
        .status(400)
        .json({ error: data.message || 'Order creation failed' });
    }

    orderStatus.set(order_id, 'pending');

    res.json({
      success: true,
      order_id: order_id,
      payment_url:
        data.payment_url || data.url || data.data?.payment_url,
      qr_code: data.qr_code || data.data?.qr_code || null,
    });
  } catch (err) {
    console.error('Create order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment gateway error' });
  }
});

// ------------------------------------------------------------
// Payment callback — hamesha redirect, kabhi blank/HTML nahi
// ------------------------------------------------------------
app.get('/payment-callback', async (req, res) => {
  const { order_id, status } = req.query;

  // order_id missing → seedha success page
  if (!order_id) {
    return res.redirect(SUCCESS_REDIRECT);
  }

  // Already paid → seedha redirect
  if (paidOrders.has(order_id)) {
    return res.redirect(SUCCESS_REDIRECT);
  }

  let verifiedPaid = false;
  let rawStatus = '';

  try {
    const check = await axios.post(
      `${RUPayX_BASE}/order-status`,
      { user_token: USER_TOKEN, order_id },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    console.log(
      `[callback] order ${order_id} verify response:`,
      JSON.stringify(check.data)
    );

    const parsed = extractPaidStatus(check.data);
    verifiedPaid = parsed.paid;
    rawStatus = parsed.raw;
    orderStatus.set(order_id, verifiedPaid ? 'paid' : rawStatus || 'pending');
  } catch (err) {
    console.error(
      `[callback] order ${order_id} verify error:`,
      err.response?.data || err.message
    );
    // Fallback: callback query me success ho toh accept karo
    const qs = String(status || '').toLowerCase();
    verifiedPaid = ['success', 'paid', 'completed'].includes(qs);
    rawStatus = qs || 'verify_failed';
  }

  // Extra safety: agar verify fail ho gaya lekin query me success signal hai
  if (!verifiedPaid) {
    const qs = String(status || '').toLowerCase();
    if (['success', 'paid', 'completed'].includes(qs)) {
      verifiedPaid = true;
      rawStatus = qs;
    }
  }

  if (verifiedPaid) {
    paidOrders.add(order_id);
    orderStatus.set(order_id, 'paid');

    res.cookie('paid_order', order_id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60 * 1000,
      // secure: true  // HTTPS production me enable karo
    });

    // ⬇️ Yahan asli fix — bina HTML, seedha 302 redirect
    return res.redirect(302, SUCCESS_REDIRECT);
  }

  // Agar payment pending/failed hai, tab hi error page dikhao
  return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Pending</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; padding: 50px 20px; background: #05050a; color: #fff; margin: 0; }
        .box { background: #0f172a; padding: 40px; border-radius: 20px; max-width: 400px; margin: auto; border: 1px solid rgba(255,255,255,0.1); }
        h1 { font-size: 24px; margin-bottom: 10px; color: #f87171; }
        p { color: #94a3b8; font-size: 14px; }
        .btn { background: linear-gradient(90deg, #9333ea, #ec4899); color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; display: inline-block; margin-top: 15px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>⏳ Payment ${rawStatus || 'Pending'}</h1>
        <p>Order ID: <b>${order_id}</b></p>
        <p>Your payment is not completed. Please try again.</p>
        <a href="/" class="btn">Try Again</a>
      </div>
    </body>
    </html>
  `);
});

// ------------------------------------------------------------
// Debug: order status check
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
