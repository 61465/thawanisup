/**
 * Canvas Worker Thread — يولّد الفواتير في thread منفصل
 *
 * عند توليد فاتورة كبيرة (100+ منتج)، @napi-rs/canvas يحجب event-loop
 * 500ms-2s. هذا الـ worker يفعل ذلك في thread منفصل.
 *
 * Protocol:
 *   parent → worker: { id, op: "invoice"|"summary", payload: {...} }
 *   worker → parent: { id, ok: true, result: {filePath, fileName} } | { id, ok: false, error }
 */

"use strict";

const { parentPort } = require("worker_threads");

if (!parentPort) {
  console.error("canvas-worker.js: لا يمكن تشغيله مباشرة، يجب استخدامه كـ Worker");
  process.exit(1);
}

const invoiceImage = require("./invoice-image");

parentPort.on("message", async (msg) => {
  const { id, op, payload } = msg;
  try {
    let result;
    if (op === "invoice") {
      result = await invoiceImage.generateInvoiceImage(payload);
    } else if (op === "summary") {
      result = await invoiceImage.generateSummaryImage(payload);
    } else {
      throw new Error("op غير مدعوم: " + op);
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});

parentPort.postMessage({ ready: true });
