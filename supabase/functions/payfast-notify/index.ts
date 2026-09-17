// Supabase Edge Function: payfast-notify
// This receives PayFast's server-to-server payment confirmation (ITN),
// verifies it's genuinely from PayFast, then marks the order/promotion as paid.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PAYFAST_SANDBOX = true; // match this to the frontend setting

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  try {
    const body = await req.text();
    const params = new URLSearchParams(body);
    const data = Object.fromEntries(params.entries());

    // Step 1: Verify this request genuinely came from PayFast's servers
    const validateUrl = PAYFAST_SANDBOX
      ? 'https://sandbox.payfast.co.za/eng/query/validate'
      : 'https://www.payfast.co.za/eng/query/validate';

    const validateResponse = await fetch(validateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const validateResult = await validateResponse.text();

    if (validateResult.trim() !== 'VALID') {
      console.error('PayFast ITN failed validation:', validateResult);
      return new Response('Invalid', { status: 400 });
    }

    // Step 2: Only trust "COMPLETE" payment statuses
    if (data.payment_status !== 'COMPLETE') {
      return new Response('OK - not complete yet', { status: 200 });
    }

    const paymentId = data.m_payment_id;
    const amountPaid = parseFloat(data.amount_gross);
    const type = data.custom_str1; // 'order' or 'promotion'

    // Step 3: Update the right table depending on what was paid for
    if (type === 'order') {
      const { data: order, error: fetchErr } = await supabase
        .from('orders')
        .select('*')
        .eq('id', paymentId)
        .single();

      if (fetchErr || !order) {
        console.error('Order not found:', paymentId);
        return new Response('Order not found', { status: 404 });
      }

      // Sanity check: amount paid should match what we expect
      if (Math.abs(amountPaid - order.amount_paid) > 0.5) {
        console.error('Amount mismatch on order', paymentId, amountPaid, order.amount_paid);
        return new Response('Amount mismatch', { status: 400 });
      }

      await supabase.from('orders').update({ payment_status: 'paid' }).eq('id', paymentId);
      await supabase.from('listings').update({ sold: true }).eq('id', order.listing_id);

    } else if (type === 'promotion') {
      const { data: promo, error: fetchErr } = await supabase
        .from('promotions')
        .select('*')
        .eq('id', paymentId)
        .single();

      if (fetchErr || !promo) {
        console.error('Promotion not found:', paymentId);
        return new Response('Promotion not found', { status: 404 });
      }

      await supabase
        .from('promotions')
        .update({ payment_status: 'paid', status: 'pending_admin_review' })
        .eq('id', paymentId);

    } else if (type === 'cart') {
      const { data: cartOrders, error: fetchErr } = await supabase
        .from('orders')
        .select('*')
        .eq('cart_session_id', paymentId);

      if (fetchErr || !cartOrders || cartOrders.length === 0) {
        console.error('Cart orders not found:', paymentId);
        return new Response('Cart orders not found', { status: 404 });
      }

      const expectedTotal = cartOrders.reduce((sum, o) => sum + Number(o.amount_paid), 0);
      if (Math.abs(amountPaid - expectedTotal) > 0.5) {
        console.error('Cart amount mismatch', paymentId, amountPaid, expectedTotal);
        return new Response('Amount mismatch', { status: 400 });
      }

      await supabase.from('orders').update({ payment_status: 'paid' }).eq('cart_session_id', paymentId);
      const listingIds = cartOrders.map(o => o.listing_id);
      await supabase.from('listings').update({ sold: true }).in('id', listingIds);
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Edge Function error:', err);
    return new Response('Server error', { status: 500 });
  }
});
