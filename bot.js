require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const token = process.env.TOKEN;
const SHEET_URL = process.env.SHEET_URL;
const GRUPO_ID = process.env.GRUPO_ID;

const bot = new TelegramBot(token, { polling: true });

require('http').createServer((req, res) => res.end('ok')).listen(3000);

let usuarios = {};
let contador = 1;

// 🔹 Iniciar ticket
function iniciarTicket(chatId) {
    if (usuarios[chatId]) {
        return bot.sendMessage(chatId, "⚠️ Ya tienes un ticket en proceso");
    }

    usuarios[chatId] = { paso: 'tipo' };

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

// 🔹 Obtener tickets
async function obtenerTickets() {
    const res = await axios.get(SHEET_URL);
    return res.data;
}

// 🔹 Actualizar estado
async function actualizarEstado(id, estado) {
    await axios.post(SHEET_URL, {
        action: "update",
        id,
        estado
    });
}

// 🔹 START (ACTUALIZADO 🔥)
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "👋 Bienvenido al sistema TI", {
        reply_markup: {
            keyboard: [
                ["🎫 Nuevo Ticket"],
                ["📋 Mis Tickets", "🗂 Historial"],
                ["❓ Ayuda"]
            ],
            resize_keyboard: true
        }
    });
});

bot.onText(/\/nuevo/, (msg) => iniciarTicket(msg.chat.id));

// 🔘 CALLBACKS
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    // 👉 CAMBIAR ESTADO
    if (data.startsWith("estado_")) {
        const ticketId = data.split("_")[1];

        usuarios[chatId] = {
            paso: "estado",
            ticketId
        };

        return bot.sendMessage(chatId, "Selecciona nuevo estado:", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🟡 En proceso", callback_data: "setestado_En proceso" }],
                    [{ text: "🟢 Cerrado", callback_data: "setestado_Cerrado" }]
                ]
            }
        });
    }

    if (data.startsWith("setestado_")) {
        const nuevoEstado = data.split("_")[1];
        const ticketId = usuarios[chatId]?.ticketId;

        await actualizarEstado(ticketId, nuevoEstado);

        bot.sendMessage(chatId, `✅ Ticket ${ticketId} actualizado a: ${nuevoEstado}`);
        delete usuarios[chatId];
        return;
    }

    if (!usuarios[chatId]) return;

    // Tipo
    if (data.startsWith("tipo_")) {
        usuarios[chatId].tipo = data.split("_")[1];
        usuarios[chatId].paso = "sucursal";

        return bot.sendMessage(chatId, "🏢 ¿Qué sucursal es?");
    }

    // Prioridad
    if (data.startsWith("prioridad_")) {
        usuarios[chatId].prioridad = data.split("_")[1];
        usuarios[chatId].paso = "confirmacion";

        const u = usuarios[chatId];

        const resumen = `
📋 *Resumen del ticket*

👤 Usuario: ${query.from.first_name}
📌 Tipo: ${u.tipo}
🏢 Sucursal: ${u.sucursal}
👤 Reporta: ${u.reportante}
📝 ${u.descripcion}
⚡ ${u.prioridad}
        `;

        return bot.sendMessage(chatId, resumen, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ Confirmar", callback_data: "confirmar" }],
                    [{ text: "❌ Cancelar", callback_data: "cancelar" }]
                ]
            }
        });
    }

    if (data === "confirmar") {
        return guardarTicket(chatId, query.from);
    }

    if (data === "cancelar") {
        delete usuarios[chatId];
        return bot.sendMessage(chatId, "❌ Ticket cancelado");
    }
});

// 📝 MENSAJES (ACTUALIZADO 🔥)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === "🎫 Nuevo Ticket") return iniciarTicket(chatId);

    // 📋 MIS TICKETS (solo activos)
    if (text === "📋 Mis Tickets") {
        try {
            const tickets = await obtenerTickets();

            const lista = tickets
                .filter(t => 
                    t.usuario === msg.from.first_name &&
                    t.estado !== "Cerrado"
                )
                .slice(-5);

            if (!lista.length) {
                return bot.sendMessage(chatId, "📭 No tienes tickets activos");
            }

            for (let t of lista) {
                await bot.sendMessage(chatId, `
🎫 ${t.id}
📌 ${t.tipo}
🏢 ${t.sucursal}
👤 ${t.reportante}
⚡ ${t.prioridad}
📊 ${t.estado}
                `, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🔄 Cambiar estado", callback_data: "estado_" + t.id }]
                        ]
                    }
                });
            }

        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, "❌ Error al obtener tickets");
        }

        return;
    }

    // 🗂 HISTORIAL (NUEVO 🔥)
    if (text === "🗂 Historial") {
        try {
            const tickets = await obtenerTickets();

            const lista = tickets
                .filter(t => t.usuario === msg.from.first_name)
                .slice(-10);

            if (!lista.length) {
                return bot.sendMessage(chatId, "📭 No tienes historial");
            }

            for (let t of lista) {
                await bot.sendMessage(chatId, `
🎫 ${t.id}
📌 ${t.tipo}
🏢 ${t.sucursal}
👤 ${t.reportante}
⚡ ${t.prioridad}
📊 ${t.estado}
                `);
            }

        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, "❌ Error al obtener historial");
        }

        return;
    }

    if (text === "❓ Ayuda") {
        return bot.sendMessage(chatId, "Usa 🎫 para crear ticket");
    }

    if (!usuarios[chatId]) return;
    if (text && text.startsWith('/')) return;

    const estado = usuarios[chatId];

    if (estado.paso === "sucursal") {
        estado.sucursal = text;
        estado.paso = "reportante";
        return bot.sendMessage(chatId, "👤 ¿Quién reporta?");
    }

    if (estado.paso === "reportante") {
        estado.reportante = text;
        estado.paso = "descripcion";
        return bot.sendMessage(chatId, "📝 Describe el problema:");
    }

    if (estado.paso === "descripcion") {
        estado.descripcion = text;
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
});

// 💾 GUARDAR
async function guardarTicket(chatId, user) {
    try {
        const id = "TI-" + String(contador).padStart(4, '0');
        const d = usuarios[chatId];

        await axios.post(SHEET_URL, {
            id,
            fecha: new Date().toLocaleString(),
            usuario: user.first_name,
            tipo: d.tipo,
            sucursal: d.sucursal,
            reportante: d.reportante,
            descripcion: d.descripcion,
            prioridad: d.prioridad
        });

        bot.sendMessage(chatId, `✅ Ticket creado: ${id}`);

        delete usuarios[chatId];
        contador++;

    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, "❌ Error al guardar");
    }
}