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

    // Agar user already paid hai, naya order mat banao
    const paidCookie = req.cookies.paid_order;
    if (paidCookie && paidOrders.has(paidCookie)) {
      return res.json({
        success: true,
        already_paid: true,
        redirect_url: SUCCESS_REDIRECT
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
      remark1: 'Website Payment'
    };

    const response = await axios.post(`${RUPayX_BASE}/create-order`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
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
      payment_url: data.payment_url || data.url || data.data?.payment_url,
      qr_code: data.qr_code || data.data?.qr_code || null
    });
  } catch (err) {
    console.error('Create order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment gateway error' });
  }
});

// ------------------------------------------------------------
// Payment callback — Direct Redirect without showing HTML
// ------------------------------------------------------------
app.get('/payment-callback', async (req, res) => {
  const { order_id, status } = req.query;

  // Agar order_id nahi hai toh direct Netlify bhej do
  if (!order_id) {
    return res.redirect(SUCCESS_REDIRECT);
  }

  // Agar already paid hai to seedha success redirect
  if (paidOrders.has(order_id)) {
    return res.redirect(SUCCESS_REDIRECT);
  }

  let verifiedPaid = false;

  try {
    const check = await axios.post(
      `${RUPayX_BASE}/order-status`,
      { user_token: USER_TOKEN, order_id },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const gw = check.data?.status ?? check.data?.result?.status ?? '';
    const gwStr = String(gw).toLowerCase();

    verifiedPaid =
      gwStr === 'success' || gwStr === 'paid' || gwStr === 'completed';
    orderStatus.set(order_id, verifiedPaid ? 'paid' : gwStr || 'pending');
  } catch (err) {
    console.error('Verify error:', err.response?.data || err.message);
    // Fallback: verify fail ho but query me success ho
    verifiedPaid = status === 'success' || status === 'SUCCESS';
  }

  // Test order ke liye direct redirect
  if (order_id === 'test123') {
    return res.redirect(SUCCESS_REDIRECT);
  }

  if (verifiedPaid) {
    paidOrders.add(order_id);

    res.cookie('paid_order', order_id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60 * 1000
      // secure: true  // HTTPS production me enable karo
    });

    // BINA HTML DIKHAYE, SEEDHA REDIRECT KARO!
    return res.redirect(SUCCESS_REDIRECT);
  }

  // Agar payment fail/pending ho toh error page dikhao
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
        <h1>⏳ Payment ${status || 'Pending'}</h1>
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
    paid: paidOrders.has(order_id)
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on ${BASE_URL}`));
