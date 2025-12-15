const express = require('express');
const client = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8888;

// Инициализация Telegram-бота (ДО обработчиков команд!)
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не найден в .env!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Тестовые маршруты для БД (как раньше)
app.get('/test-insert', async (req, res) => { /* ... */ });
app.get('/test-select', async (req, res) => { /* ... */ });

// Обработчик /start (теперь bot определён!)
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || 'unknown';
  const firstName = msg.from.first_name || 'User';

  try {
    const result = await client.query(
      'INSERT INTO users (telegram_id, username, first_name) VALUES ($1, $2, $3) ON CONFLICT (telegram_id) DO UPDATE SET username = $2, first_name = $3 RETURNING *',
      [chatId.toString(), username, firstName]
    );
	console.log('Сохранено в БД:', result.rows[0]);


    bot.sendMessage(chatId, `
      Привет, ${firstName}!  
      Твои данные сохранены:  
      - ID: ${result.rows[0].id}  
      - Username: @${username}  
      - Дата регистрации: ${new Date(result.rows[0].created_at).toLocaleDateString()}
    `);
  } catch (err) {
    console.error('DB Save Error:', err);
    bot.sendMessage(chatId, 'Ошибка сохранения данных. Попробуйте позже.');
  }
});

// Обработчик /myprofile
bot.onText(/\/myprofile/, async (msg) => {
  console.log('Получен запрос /myprofile от:', msg.chat.id); // Отладка

  const chatId = msg.chat.id;

  try {
    console.log('Выполняем запрос к БД для ID:', chatId.toString()); // Отладка
    const result = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [chatId.toString()]
    );

    console.log('Результат из БД:', result.rows); // Отладка

    if (result.rows.length > 0) {
      const user = result.rows[0];
      bot.sendMessage(chatId, `
        Ваш профиль:  
        - ID: ${user.id}  
        - Username: @${user.username}  
        - Имя: ${user.first_name}  
        - Дата регистрации: ${new Date(user.created_at).toLocaleDateString()}
      `);
    } else {
      bot.sendMessage(chatId, 'Вы ещё не зарегистрированы. Отправьте /start.');
    }
  } catch (err) {
    console.error('DB Fetch Error:', err);
    bot.sendMessage(chatId, 'Ошибка загрузки профиля. Попробуйте позже.');
  }
});

bot.onText(/\/create_order/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || 'unknown';

  // Пример использования: /create_order 100 USD buy
  const args = msg.text.split(' ').slice(1);
  if (args.length !== 3) {
    return bot.sendMessage(chatId, 'Используйте: /create_order <сумма> <валюта> <buy/sell>\nПример: /create_order 100 USD buy');
  }

  const [amountStr, currency, orderType] = args;
  const amount = parseFloat(amountStr);

  if (!amount || amount <= 0) {
    return bot.sendMessage(chatId, 'Сумма должна быть положительным числом!');
  }

  if (!['buy', 'sell'].includes(orderType)) {
    return bot.sendMessage(chatId, 'Тип заказа должен быть buy или sell!');
  }

  try {
    const result = await client.query(
      'INSERT INTO orders (telegram_id, username, amount, currency, order_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [chatId.toString(), username, amount, currency.toUpperCase(), orderType]
    );

    bot.sendMessage(chatId, `
      Заявка создана!  
      - ID: ${result.rows[0].id}  
      - Сумма: ${amount} ${currency.toUpperCase()}  
      - Тип: ${orderType === 'buy' ? 'Покупка' : 'Продажа'}  
      - Статус: ${result.rows[0].status}
    `);
  } catch (err) {
    console.error('Order creation error:', err);
    bot.sendMessage(chatId, 'Ошибка создания заявки. Попробуйте позже.');
  }
});

bot.onText(/\/my_orders/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const result = await client.query(
      'SELECT * FROM orders WHERE telegram_id = $1 AND status = \'active\' ORDER BY created_at DESC',
      [chatId.toString()]
    );

    if (result.rows.length > 0) {
      let response = 'Ваши активные заявки:\n\n';
      result.rows.forEach(order => {
        response += `
          ID: ${order.id}  
          Сумма: ${order.amount} ${order.currency}  
          Тип: ${order.order_type === 'buy' ? 'Покупка' : 'Продажа'}  
          Создано: ${new Date(order.created_at).toLocaleString()}  
          --------
        `;
      });
      bot.sendMessage(chatId, response);
    } else {
      bot.sendMessage(chatId, 'У вас нет активных заявок.');
    }
  } catch (err) {
    console.error('Fetch orders error:', err);
    bot.sendMessage(chatId, 'Ошибка загрузки заявок. Попробуйте позже.');
  }
});

bot.onText(/\/find_matches/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    // Получаем все активные заявки пользователя
    const userOrders = await client.query(
      'SELECT * FROM orders WHERE telegram_id = $1 AND status = \'active\'',
      [chatId.toString()]
    );

    if (userOrders.rows.length === 0) {
      return bot.sendMessage(chatId, 'Сначала создайте заявку через /create_order');
    }

    let matches = [];
    for (const order of userOrders.rows) {
      // Ищем противоположные заявки
      const oppositeType = order.order_type === 'buy' ? 'sell' : 'buy';
      const matchResult = await client.query(
        'SELECT * FROM orders WHERE currency = $1 AND order_type = $2 AND status = \'active\' AND telegram_id != $3 LIMIT 5',
        [order.currency, oppositeType, chatId.toString()]
      );
      matches = matches.concat(matchResult.rows);
    }

    if (matches.length > 0) {
      let response = 'Найденные совпадения:\n\n';
      matches.forEach(match => {
        response += `
          ID: ${match.id}  
          Пользователь: @${match.username}  
          Сумма: ${match.amount} ${match.currency}  
          Тип: ${match.order_type === 'buy' ? 'Покупка' : 'Продажа'}  
          --------
        `;
      });
      bot.sendMessage(chatId, response);
    } else {
      bot.sendMessage(chatId, 'Совпадений не найдено.');
    }
  } catch (err) {
    console.error('Find matches error:', err);
    bot.sendMessage(chatId, 'Ошибка поиска совпадений. Попробуйте позже.');
  }
});

bot.onText(/\/accept_order (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const orderId = match[1];

  try {
    const orderResult = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND status = \'active\'',
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      return bot.sendMessage(chatId, 'Заявка не найдена или уже завершена.');
    }

    const targetOrder = orderResult.rows[0];

    if (targetOrder.telegram_id === chatId.toString()) {
      return bot.sendMessage(chatId, 'Нельзя принять свою собственную заявку.');
    }

    // 1. Обновляем статусы заявок
    await client.query(
      'UPDATE orders SET status = \'completed\', completed_at = NOW() WHERE id = $1 OR (telegram_id = $2 AND currency = $3 AND order_type != $4 AND status = \'active\')',
      [orderId, chatId.toString(), targetOrder.currency, targetOrder.order_type]
    );

    // 2. Записываем сделку в историю
    await client.query(
      'INSERT INTO transactions (buyer_id, seller_id, amount, currency) VALUES ($1, $2, $3, $4)',
      [chatId.toString(), targetOrder.telegram_id, targetOrder.amount, targetOrder.currency]
    );

    bot.sendMessage(chatId, `
      Сделка подтверждена!  
      - ID заявки: ${orderId}  
      - Валюта: ${targetOrder.currency}  
      - Сумма: ${targetOrder.amount}  
      - Контрагент: @${targetOrder.username}  
    `);

    bot.sendMessage(targetOrder.telegram_id, `
      Ваша заявка №${orderId} принята!  
      Сделка завершена с пользователем @${msg.from.username || 'unknown'}.  
    `);
  } catch (err) {
    console.error('Accept order error:', err);
    bot.sendMessage(chatId, 'Ошибка при принятии заявки. Попробуйте позже.');
  }
});



bot.onText(/\/my_transactions/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const result = await client.query(
      `SELECT * FROM transactions
       WHERE buyer_id = $1 OR seller_id = $1
       ORDER BY created_at DESC`,
      [chatId.toString()]
    );

    if (result.rows.length > 0) {
      let response = 'История ваших сделок:\n\n';
      result.rows.forEach(tx => {
        const role = tx.buyer_id === chatId.toString() ? 'Покупка' : 'Продажа';
        const counterparty = tx.buyer_id === chatId.toString() ? tx.seller_id : tx.buyer_id;
        response += `
          ID: ${tx.id}  
          Тип: ${role}  
          Сумма: ${tx.amount} ${tx.currency}  
          Контрагент: ${counterparty}  
          Дата: ${new Date(tx.created_at).toLocaleString()}  
          --------
        `;
      });
      bot.sendMessage(chatId, response);
    } else {
      bot.sendMessage(chatId, 'У вас нет завершённых сделок.');
    }
  } catch (err) {
    console.error('Fetch transactions error:', err);
    bot.sendMessage(chatId, 'Ошибка загрузки истории. Попробуйте позже.');
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
