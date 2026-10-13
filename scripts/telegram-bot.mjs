import fs from "node:fs/promises";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const KEY_HEX = process.env.BOT_STATE_KEY || "";
const MODE = process.env.BOT_MODE || "poll";
const STATE_PATH = ".bot/state.enc";
const INVENTORY_PATH = "inventory.json";
const PRODUCTS_PATH = "products.json";
const SITE_URL = process.env.SITE_URL || "https://cletyoru.github.io/formyla-site/#buy";

if (!TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN secret.");
if (!/^[a-fA-F0-9]{64}$/.test(KEY_HEX)) {
  throw new Error("Missing or invalid BOT_STATE_KEY secret. It must be 64 hexadecimal characters (32 random bytes).");
}
const key = Buffer.from(KEY_HEX, "hex");

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readEncryptedState() {
  try {
    const encrypted = JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
    if (encrypted.v !== 1) throw new Error("Unsupported bot state version.");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encrypted.data, "base64")),
      decipher.final()
    ]).toString("utf8");
    const parsed = JSON.parse(plain);
    return {
      state: {
        offset: Number.isSafeInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0,
        subscribers: Array.isArray(parsed.subscribers) ? parsed.subscribers.map(String) : [],
        processedEvents: Array.isArray(parsed.processedEvents) ? parsed.processedEvents.map(String).slice(-500) : []
      },
      exists: true
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { state: { offset: 0, subscribers: [], processedEvents: [] }, exists: false };
    }
    throw new Error("Cannot decrypt bot state. Check BOT_STATE_KEY; state was not overwritten.");
  }
}

async function writeEncryptedState(state) {
  await fs.mkdir(".bot", { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(state), "utf8");
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const encrypted = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64")
  };
  await fs.writeFile(STATE_PATH, JSON.stringify(encrypted) + "\n", { mode: 0o600 });
}

async function telegram(method, body) {
  const response = await fetch("https://api.telegram.org/bot" + TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    const error = new Error(payload.description || ("Telegram API HTTP " + response.status));
    error.status = response.status;
    throw error;
  }
  return payload.result;
}

const BUY_KEYBOARD = {
  inline_keyboard: [[{
    text: "Перейти к покупке товара",
    url: SITE_URL,
    style: "success"
  }]]
};

async function sendMessage(chatId, text, withButton) {
  const body = { chat_id: String(chatId), text: text };
  if (withButton) body.reply_markup = BUY_KEYBOARD;
  try {
    await telegram("sendMessage", body);
  } catch (error) {
    // Some Bot API/client versions may not accept the optional button style.
    if (withButton && /style|BUTTON_STYLE|can't parse/i.test(error.message)) {
      const fallback = { chat_id: String(chatId), text: text, reply_markup: {
        inline_keyboard: [[{ text: "Перейти к покупке товара", url: SITE_URL }]]
      }};
      await telegram("sendMessage", fallback);
      return;
    }
    throw error;
  }
}

const WELCOME = "Добро пожаловать в Formyla!\n\nЗдесь будут появляться уведомления о пополнении ассортимента. Чтобы отключить уведомления, отправь /stop.";

async function pollUpdates(state) {
  const updates = await telegram("getUpdates", {
    offset: state.offset || 0,
    timeout: 0,
    allowed_updates: ["message"]
  });
  let changed = false;
  for (const update of updates) {
    state.offset = Math.max(state.offset, Number(update.update_id) + 1);
    changed = true;
    const message = update.message;
    if (!message || !message.chat || message.chat.type !== "private" || !message.text) continue;
    const command = message.text.trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
    const chatId = String(message.chat.id);
    if (command === "/start") {
      if (!state.subscribers.includes(chatId)) {
        state.subscribers.push(chatId);
        changed = true;
      }
      try { await sendMessage(chatId, WELCOME, false); } catch (error) {
        console.error("Could not send welcome message to one chat:", error.message);
      }
    } else if (command === "/stop") {
      const before = state.subscribers.length;
      state.subscribers = state.subscribers.filter((id) => id !== chatId);
      if (state.subscribers.length !== before) changed = true;
      try { await sendMessage(chatId, "Уведомления Formyla отключены. Чтобы подписаться снова, отправь /start.", false); } catch (error) {
        console.error("Could not send unsubscribe confirmation:", error.message);
      }
    } else if (command === "/help") {
      try { await sendMessage(chatId, WELCOME, false); } catch (error) {
        console.error("Could not send help message:", error.message);
      }
    }
  }
  return changed;
}

function validText(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

async function processCatalogEvent(state) {
  const eventType = process.env.EVENT_TYPE || "";
  const eventId = process.env.EVENT_ID || "";
  const productId = process.env.PRODUCT_ID || "";
  const variant = process.env.VARIANT || "";
  const requestedQuantity = Number(process.env.QUANTITY || "1");

  if (eventType !== "sale" && eventType !== "restock") throw new Error("Invalid event type.");
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(eventId)) throw new Error("Invalid event ID.");
  if (!validText(productId, 120) || !validText(variant, 120)) throw new Error("Invalid product ID or variant.");
  if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > 999) throw new Error("Quantity must be an integer from 1 to 999.");

  if (state.processedEvents.includes(eventId)) {
    console.log("Duplicate event ignored; no stock change or notification.");
    return false;
  }

  const catalogFile = await readJson(PRODUCTS_PATH, { products: [] });
  const catalog = Array.isArray(catalogFile) ? catalogFile : catalogFile.products;
  const product = Array.isArray(catalog) ? catalog.find((item) => String(item.id) === productId) : null;
  if (!product || !Array.isArray(product.items) || !product.items.some((item) => String(item) === variant)) {
    throw new Error("The product or variant no longer exists in products.json; event was not processed.");
  }

  const inventoryFile = await readJson(INVENTORY_PATH, { items: [] });
  if (!Array.isArray(inventoryFile.items)) inventoryFile.items = [];
  let stock = inventoryFile.items.find((item) => item.productId === productId && item.variant === variant);
  if (!stock) {
    stock = { productId: productId, productName: String(product.name || ""), variant: variant, quantity: 0 };
    inventoryFile.items.push(stock);
  }
  const currentQuantity = Number.isInteger(stock.quantity) && stock.quantity >= 0 ? stock.quantity : 0;
  if (eventType === "sale" && currentQuantity < requestedQuantity) {
    throw new Error("Not enough stock. Current quantity is " + currentQuantity + "; no sale notification sent.");
  }
  stock.productName = String(product.name || "");
  stock.quantity = eventType === "sale" ? currentQuantity - requestedQuantity : currentQuantity + requestedQuantity;
  if (stock.quantity > 99999) throw new Error("Inventory limit exceeded.");
  await fs.writeFile(INVENTORY_PATH, JSON.stringify(inventoryFile, null, 2) + "\n", "utf8");

  const category = String(product.category || "pods");
  let message;
  if (eventType === "sale") {
    if (category === "liquids") {
      message = "Купили жидкость «" + String(product.name || productId) + "»\nВкус: " + variant;
    } else if (category === "pods") {
      message = "Купили под «" + variant + "»\nЕдиница товара: 1";
    } else {
      message = "Купили товар «" + variant + "»\nЕдиница товара: 1";
    }
    for (let unit = 0; unit < requestedQuantity; unit += 1) {
      for (const chatId of state.subscribers) {
        try {
          await sendMessage(chatId, message, true);
        } catch (error) {
          if (error.status === 403) {
            state.subscribers = state.subscribers.filter((id) => id !== chatId);
          } else {
            console.error("A notification could not be delivered to one subscriber:", error.message);
          }
        }
      }
    }
  } else {
    if (category === "liquids") {
      message = "Пополнение товара «" + String(product.name || productId) + "»\nВкус: " + variant + "\nВ наличии: " + stock.quantity;
    } else {
      message = "Пополнение товара «" + variant + "»\nВ наличии: " + stock.quantity;
    }
    for (const chatId of state.subscribers) {
      try {
        await sendMessage(chatId, message, true);
      } catch (error) {
        if (error.status === 403) {
          state.subscribers = state.subscribers.filter((id) => id !== chatId);
        } else {
          console.error("A notification could not be delivered to one subscriber:", error.message);
        }
      }
    }
  }

  state.processedEvents.push(eventId);
  state.processedEvents = state.processedEvents.slice(-500);
  console.log("Catalog event processed:", eventType, "subscribers:", state.subscribers.length, "quantity:", requestedQuantity);
  return true;
}

async function syncInventory(state) {
  const commitSha = process.env.GITHUB_SHA || "";
  const eventId = "push-" + commitSha;
  if (!/^[a-fA-F0-9-]{8,80}$/.test(eventId) || state.processedEvents.includes(eventId)) {
    console.log("Inventory push already processed or has no valid commit ID.");
    return false;
  }
  let previous = { items: [] };
  const baseSha = process.env.BASE_SHA || "";
  if (baseSha && !/^0+$/.test(baseSha)) {
    try {
      const raw = execFileSync("git", ["show", baseSha + ":inventory.json"], { encoding: "utf8" });
      previous = JSON.parse(raw);
    } catch (_) {
      previous = { items: [] };
    }
  }
  const current = await readJson(INVENTORY_PATH, { items: [] });
  const catalogFile = await readJson(PRODUCTS_PATH, { products: [] });
  const catalog = Array.isArray(catalogFile) ? catalogFile : catalogFile.products;
  const oldMap = new Map();
  (Array.isArray(previous.items) ? previous.items : []).forEach((item) => {
    oldMap.set(String(item.productId) + "\\u0000" + String(item.variant), Number(item.quantity) || 0);
  });
  let increases = 0;
  for (const item of (Array.isArray(current.items) ? current.items : [])) {
    const key = String(item.productId) + "\\u0000" + String(item.variant);
    const oldQuantity = oldMap.has(key) ? oldMap.get(key) : 0;
    const newQuantity = Number(item.quantity) || 0;
    if (newQuantity <= oldQuantity) continue;
    const product = Array.isArray(catalog) ? catalog.find((p) => String(p.id) === String(item.productId)) : null;
    if (!product) continue;
    const variant = String(item.variant || "");
    let message;
    if (String(product.category) === "liquids") {
      message = "Пополнение товара «" + String(product.name || item.productName || item.productId) + "»\\nВкус: " + variant + "\\nВ наличии: " + newQuantity;
    } else {
      message = "Пополнение товара «" + variant + "»\\nВ наличии: " + newQuantity;
    }
    for (const chatId of state.subscribers) {
      try {
        await sendMessage(chatId, message, true);
      } catch (error) {
        if (error.status === 403) state.subscribers = state.subscribers.filter((id) => id !== chatId);
        else console.error("A restock notification could not be delivered to one subscriber:", error.message);
      }
    }
    increases += 1;
  }
  state.processedEvents.push(eventId);
  state.processedEvents = state.processedEvents.slice(-500);
  console.log("Inventory push processed; restocked variants:", increases);
  return true;
}

const loaded = await readEncryptedState();
const state = loaded.state;
const before = JSON.stringify(state);
let inventoryChanged = false;
if (MODE === "poll") {
  await pollUpdates(state);
} else if (MODE === "event") {
  inventoryChanged = await processCatalogEvent(state);
} else if (MODE === "sync") {
  await syncInventory(state);
} else {
  throw new Error("Unknown BOT_MODE.");
}
const stateChanged = !loaded.exists || JSON.stringify(state) !== before;
if (stateChanged) await writeEncryptedState(state);
if (inventoryChanged) console.log("Inventory file updated.");
console.log("Bot run complete. Subscriber count:", state.subscribers.length);
