/**
 * Invoice Builder
 * Generates a formatted Arabic text invoice.
 */

function buildInvoice({ orderId, customerName, customerLocation, cart, deliveryFee = 10 }) {
  const lines = cart.map(
    (i) => `• ${i.name} × ${i.qty}  ......  ${(i.price * i.qty).toFixed(2)} ر.س`
  );
  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const grandTotal = subtotal + deliveryFee;

  return (
    `🧾 *فاتورة الطلب*\n` +
    `رقم الطلب: ${orderId}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👤 الاسم: ${customerName}\n` +
    `📍 العنوان: ${customerLocation}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    lines.join("\n") +
    `\n━━━━━━━━━━━━━━━━━━\n` +
    `المجموع الفرعي: ${subtotal.toFixed(2)} ر.س\n` +
    `رسوم التوصيل: ${deliveryFee.toFixed(2)} ر.س\n` +
    `*💰 الإجمالي: ${grandTotal.toFixed(2)} ر.س*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `طريقة الدفع: عند الاستلام 💵\n` +
    `\nشكراً لطلبك من *مقهى النخيل* ☕🌴`
  );
}

module.exports = { buildInvoice };
