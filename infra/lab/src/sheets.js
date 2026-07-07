/**
 * Google Sheets Product Loader
 * Reads from a public Google Sheet (CSV export URL).
 * No OAuth — sheet must be published to web as CSV.
 *
 * Expected columns (row 1 = headers, English only):
 *   id | name | category | price | description | available | image_url
 *
 * Robust CSV parser handles:
 *   - Quoted fields with commas inside ("کیک, فاخر")
 *   - Escaped quotes inside fields ("a""b")
 *   - Windows / Unix / Mac line endings
 *   - UTF-8 BOM (Excel exports add this)
 *   - Trailing empty cells
 */

const axios = require("axios");

const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = null;
let cacheTime = 0;

async function getProducts(category) {
  const all = await fetchAll();
  return all.filter((p) => p.category === category && isAvailable(p));
}

async function getProductById(id) {
  const all = await fetchAll();
  return all.find((p) => String(p.id) === String(id) && isAvailable(p));
}

async function getAllCategories() {
  const all = await fetchAll();
  const cats = new Set();
  all.forEach((p) => isAvailable(p) && p.category && cats.add(p.category));
  return [...cats];
}

function isAvailable(p) {
  const v = String(p.available ?? "").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no" && v !== "";
}

function clearCache() {
  cache = null;
  cacheTime = 0;
}

async function fetchAll() {
  if (cache && Date.now() - cacheTime < CACHE_TTL_MS) return cache;

  if (!SHEET_CSV_URL || SHEET_CSV_URL.includes("SHEET_ID")) {
    console.warn("⚠️  SHEET_CSV_URL not configured — using fallback products");
    return [];
  }

  try {
    const res = await axios.get(SHEET_CSV_URL, {
      timeout: 10000,
      responseType: "text",
      transformResponse: [(d) => d],
    });
    const rows = parseCSV(res.data);
    cache = rows.map(normalizeRow);
    cacheTime = Date.now();
    return cache;
  } catch (err) {
    console.error("❌ Failed to fetch products sheet:", err.message);
    if (cache) return cache;
    return [];
  }
}

function normalizeRow(row) {
  return {
    id: String(row.id || "").trim(),
    name: String(row.name || "").trim(),
    category: String(row.category || "").trim().toLowerCase(),
    price: parseFloat(row.price) || 0,
    description: String(row.description || "").trim(),
    available: row.available,
    image_url: String(row.image_url || row.image || "").trim(),
  };
}

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = parseRecords(text);
  if (records.length === 0) return [];

  const headers = records[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return records.slice(1)
    .filter((r) => r.some((c) => c !== ""))
    .map((cells) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
      return obj;
    });
}

function parseRecords(text) {
  const records = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      row.push(cell); records.push(row); row = []; cell = ""; i++; continue;
    }
    if (ch === "\n") {
      row.push(cell); records.push(row); row = []; cell = ""; i++; continue;
    }
    cell += ch; i++;
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell);
    records.push(row);
  }
  return records;
}

module.exports = {
  getProducts,
  getProductById,
  getAllCategories,
  clearCache,
  _parseCSV: parseCSV,
};
