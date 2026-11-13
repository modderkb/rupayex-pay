require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const RUPayX_BASE = 'https://rupayex.net/api';
const USER_TOKEN = process.env.RUPAYEX_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Create order endpoint
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount = 499, customer_mobile = '' } = req.body;

    if (amount < 1 || amount > 100000) {
      return res.status(400).json({ error: 'Invalid amount (1-100000)' });
    }

    const order_id = 'ORD' + Date.now() + crypto.randomBytes(3).toString('hex');
    const redirect_url = ${BASE_URL}/payment-callback?redirect_to=https://serverhtml.netlify.app/;

    const payload = {
      user_token: USER_TOKEN,
      amount: amount,
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
      return res.status(400).json({ error: data.message || 'Order creation failed' });
    }

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

// Payment callback
app.get('/payment-callback', (req, res) => {
  const { order_id, status, redirect_to } = req.query;
  
  // Agar status success hai, toh 3 second baad redirect karega
  const isSuccess = (status === 'success' || status === 'SUCCESS' || status === true);
  const finalRedirect = redirect_to || '/'; 
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; padding: 50px 20px; background: #05050a; color: #fff; }
        .box { background: #0f172a; padding: 40px; border-radius: 20px; max-width: 400px; margin: auto; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        h1 { font-size: 24px; margin-bottom: 10px; color: ${isSuccess ? '#4ade80' : '#f87171'}; }
        p { color: #94a3b8; font-size: 14px; margin-bottom: 20px; }
        .btn { background: linear-gradient(90deg, #9333ea, #ec4899); color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; display: inline-block; margin-top: 15px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>${isSuccess ? '✅ Payment Successful!' : '⏳ Payment ' + (status || 'Pending')}</h1>
        <p>Order ID: <b>${order_id || 'N/A'}</b></p>
        ${isSuccess ? `<p>Redirecting you back in 3 seconds...</p>
        <a href="${finalRedirect}" class="btn">Click here if not redirected</a>
        <script>setTimeout(() => { window.location.href = "${finalRedirect}"; }, 3000);</script>` 
        : `<p>Your payment is not completed or pending. Please check your app.</p>`}
      </div>
    </body>
    </html>
  `);
});
