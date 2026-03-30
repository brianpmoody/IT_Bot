require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// 🔐 Variables de entorno
const token = process.env.TOKEN;
const SHEET_URL = process.env.SHEET_URL;
const GRUPO_ID = process.env.GRUPO_ID;

const bot = new TelegramBot(token, { polling: true });

// Mantener activo en Render
require('http').createServer((req, res) => res.end('ok')).listen(3000);

// 🧠 Estado de usuarios
let usuarios = {};
let contador = 1;

// 🧩 FUNCIÓN REUTILIZABLE (NUEVO)
function iniciarTicket(chatId) {
    if (usuarios[chatId]) {
        return bot.sendMessage(chatId, "⚠️ Ya tienes un ticket en proceso");
    }

    usuarios[chatId] = {
        paso: 'tipo'
    };

    bot.sendMessage(chatId, "Selecciona el tipo de problema:", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🌐 Red", callback_data: "tipo_Red" }],
                [{ text: "🖨 Impresora", callback_data: "tipo_Impresora" }],
                [{ text: "💻 Sistema", callback_data: "tipo_Sistema" }],
                [{ text: "📹 Cámaras", callback_data: "tipo_Camaras" }]
            ]
        }
    });
}

// 🎯 Comando inicio (MEJORADO)
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "👋 Bienvenido al sistema de soporte TI", {
        reply_markup: {
            keyboard: [
                ["🎫 Nuevo Ticket"],
                ["❓ Ayuda"]
            ],
            resize_keyboard: true
        }
    });
});

// 🎫 Comando /nuevo (ahora reutiliza función)
bot.onText(/\/nuevo/, (msg) => {
    iniciarTicket(msg.chat.id);
});

// 🔘 Manejo de botones inline
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (!usuarios[chatId]) return;

    // Tipo
    if (data.startsWith("tipo_")) {
        usuarios[chatId].tipo = data.split("_")[1];
        usuarios[chatId].paso = "descripcion";

        bot.sendMessage(chatId, "📝 Describe el problema:");
    }

    // Prioridad
    if (data.startsWith("prioridad_")) {
        usuarios[chatId].prioridad = data.split("_")[1];
        usuarios[chatId].paso = "confirmacion";

        const resumen = `
📋 *Resumen del ticket*

👤 Usuario: ${query.from.first_name}
📌 Tipo: ${usuarios[chatId].tipo}
📝 Descripción: ${usuarios[chatId].descripcion}
⚡ Prioridad: ${usuarios[chatId].prioridad}
        `;

        bot.sendMessage(chatId, resumen, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ Confirmar", callback_data: "confirmar" }],
                    [{ text: "❌ Cancelar", callback_data: "cancelar" }]
                ]
            }
        });
    }

    // Confirmar
    if (data === "confirmar") {
        guardarTicket(chatId, query.from);
    }

    // Cancelar
    if (data === "cancelar") {
        delete usuarios[chatId];
        bot.sendMessage(chatId, "❌ Ticket cancelado");
    }

    bot.answerCallbackQuery(query.id);
});

// 📝 Mensajes (INTEGRADO CON BOTÓN)
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // 🎫 BOTÓN NUEVO TICKET (NUEVO)
    if (text === "🎫 Nuevo Ticket") {
        return iniciarTicket(chatId);
    }

    // ❓ AYUDA (opcional)
    if (text === "❓ Ayuda") {
        return bot.sendMessage(chatId, "Usa el botón 🎫 para crear un ticket");
    }

    if (!usuarios[chatId]) return;
    if (text && text.startsWith('/')) return;

    const estado = usuarios[chatId];

    // Descripción
    if (estado.paso === "descripcion") {
        estado.descripcion = text || "Sin descripción";
        estado.paso = "prioridad";

        return bot.sendMessage(chatId, "Selecciona prioridad:", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔴 Alta", callback_data: "prioridad_Alta" }],
                    [{ text: "🟡 Media", callback_data: "prioridad_Media" }],
                    [{ text: "🟢 Baja", callback_data: "prioridad_Baja" }]
                ]
            }
        });
    }

    // Foto opcional
    if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        estado.foto = fileId;

        bot.sendMessage(chatId, "📸 Foto recibida correctamente");
    }
});

// 💾 Guardar ticket
async function guardarTicket(chatId, user) {
    try {
        const ticketID = "TI-" + String(contador).padStart(4, '0');
        const data = usuarios[chatId];

        const payload = {
            id: ticketID,
            fecha: new Date().toLocaleString(),
            usuario: user.first_name,
            tipo: data.tipo,
            descripcion: data.descripcion,
            prioridad: data.prioridad
        };

        await axios.post(SHEET_URL, payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        bot.sendMessage(chatId, `✅ Ticket creado: ${ticketID}`);

        if (GRUPO_ID) {
            bot.sendMessage(GRUPO_ID, `
🚨 *Nuevo Ticket*

🎫 ${ticketID}
👤 ${user.first_name}
📌 ${data.tipo}
📝 ${data.descripcion}
⚡ ${data.prioridad}
            `, { parse_mode: "Markdown" });
        }

        delete usuarios[chatId];
        contador++;

    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, "❌ Error al guardar el ticket");
    }
}
