import { Bot, InlineKeyboard } from "grammy";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRODUCTS_URL =
  process.env.PRODUCTS_URL ??
  "https://raw.githubusercontent.com/cletYoru/formyla-site/main/products.json";
const SITE_URL = "https://cletyoru.github.io/formyla-site/#buy";

if (!TOKEN) {
  console.error("Не задан TELEGRAM_BOT_TOKEN в .env");
  process.exit(1);
}

const bot = new Bot(TOKEN);

const startKeyboard = new InlineKeyboard()
  .url("Сайт для ознакомления", SITE_URL)
  .row()
  .text("Список сообщением", "catalog_list");

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Приветствуем в Formyla VapeShop!\n\nДля ознакомления с ассортиментом можете выбрать следующее.",
    { reply_markup: startKeyboard }
  );
});

const CATEGORY_NAMES = {
  liquids: "[Жидкости]",
  pods: "[Поды]",
  cartridges: "[Картриджи]"
};

function formatProduct(product) {
  const lines = [`• "${String(product.name ?? "Без названия")}"`];

  if (Array.isArray(product.items)) {
    for (const item of product.items) {
      const value = String(item).trim();
      if (value) lines.push(`-${value}`);
    }
  }

  return lines.join("\n");
}

function makeCatalogMessages(catalog) {
  if (!catalog || !Array.isArray(catalog.products)) {
    throw new Error("В products.json нет массива products.");
  }

  const categoryOrder = ["liquids", "pods", "cartridges"];
  const groups = new Map();

  for (const category of categoryOrder) groups.set(category, []);
  for (const product of catalog.products) {
    const category = String(product.category ?? "other").toLowerCase();
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(product);
  }

  const blocks = [];
  for (const [category, products] of groups) {
    if (!products.length) continue;
    blocks.push(CATEGORY_NAMES[category] ?? "[Другое]");
    for (const product of products) blocks.push(formatProduct(product));
  }

  if (!blocks.length) return ["Ассортимент пока пуст."];

  // Telegram limits a text message to 4096 characters; leave a margin.
  const messages = [];
  let current = "";

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > 3800 && current) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) messages.push(current);

  return messages;
}

bot.callbackQuery("catalog_list", async (ctx) => {
  await ctx.answerCallbackQuery();

  try {
    const response = await fetch(PRODUCTS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`GitHub вернул HTTP ${response.status}`);
    }

    const catalog = await response.json();
    const messages = makeCatalogMessages(catalog);

    for (const message of messages) {
      await ctx.reply(message);
    }
  } catch (error) {
    console.error("Не удалось получить каталог:", error);
    await ctx.reply(
      "Не удалось загрузить ассортимент. Попробуйте ещё раз немного позже."
    );
  }
});

bot.catch((error) => {
  console.error("Ошибка Telegram-бота:", error);
});

bot.start({
  onStart: (botInfo) => {
    console.log(`Бот @${botInfo.username} запущен.`);
  }
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
