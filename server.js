// Payment Callback (Fixed for about:blank & WebViews)
app.get('/payment-callback', async (req, res) => {
  const { order_id, status } = req.query;

  // Agar order_id nahi hai toh direct Netlify bhej do
  if (!order_id) {
    return res.redirect(SUCCESS_REDIRECT);
  }

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
    verifiedPaid = gwStr === 'success' || gwStr === 'paid' || gwStr === 'completed';
    orderStatus.set(order_id, verifiedPaid ? 'paid' : gwStr || 'pending');
  } catch (err) {
    verifiedPaid = status === 'success' || status === 'SUCCESS';
  }

  if (order_id === 'test123') {
     return res.redirect(SUCCESS_REDIRECT);
  }

  if (verifiedPaid) {
    paidOrders.add(order_id);
    
    // Cookie set karo
    res.cookie('paid_order', order_id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60 * 1000
    });

    // Success Page with Fallback
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Successful</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; text-align: center; padding: 50px 20px; background: #05050a; color: #fff; margin: 0; }
          .box { background: #0f172a; padding: 40px; border-radius: 20px; max-width: 400px; margin: auto; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
          h1 { font-size: 24px; margin-bottom: 10px; color: #4ade80; }
          p { color: #94a3b8; font-size: 14px; margin-bottom: 20px; }
          .btn { background: linear-gradient(90deg, #9333ea, #ec4899); color: #fff; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: bold; display: inline-block; margin-top: 15px; font-size: 16px; box-shadow: 0 4px 15px rgba(147, 51, 234, 0.4); }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>✅ Payment Successful!</h1>
          <p>Order ID: <b>${order_id}</b></p>
          <p>Redirecting you back in 2 seconds...</p>
          <a href="${SUCCESS_REDIRECT}" target="_top" class="btn">Go to Website</a>
          <script>
            // Top window me redirect karne ki koshish
            setTimeout(function(){ 
              try {
                window.top.location.href = "${SUCCESS_REDIRECT}"; 
              } catch (e) {
                window.location.href = "${SUCCESS_REDIRECT}"; 
              }
            }, 2000);
          </script>
        </div>
      </body>
      </html>
    `);
  }

  // Pending Page
  return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Pending</title>
      <style>
        body { font-family: 'Segoe UI', sans-serif; text-align: center; padding: 50px 20px; background: #05050a; color: #fff; margin: 0; }
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
