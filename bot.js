require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const token    = process.env.TOKEN;
const SHEET_URL = process.env.SHEET_URL;
const GRUPO_ID  = process.env.GRUPO_ID;

const bot = new TelegramBot(token, { polling: true });

// ─── Health check (Render / Railway) ─────────────────────────────────────────
require('http').createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
}).listen(process.env.PORT || 3000);

// ─── Sesiones en memoria ──────────────────────────────────────────────────────
let usuarios = {};
const SESSION_TTL = 30 * 60 * 1000; // 30 min

setInterval(() => {
    const ahora = Date.now();
    for (const id in usuarios) {
        if (ahora - usuarios[id].timestamp > SESSION_TTL) {
            delete usuarios[id];
            console.log(`[SESSION] Expirada: ${id}`);
        }
    }
}, 10 * 60 * 1000);

function crearSesion(chatId, datos = {}) {
    usuarios[chatId] = { ...datos, timestamp: Date.now() };
}

function actualizarSesion(chatId, datos = {}) {
    if (usuarios[chatId]) {
        usuarios[chatId] = { ...usuarios[chatId], ...datos, timestamp: Date.now() };
    }
}

// ─── Sheets API ───────────────────────────────────────────────────────────────
const http = axios.create({ timeout: 5000 });

async function obtenerTickets() {
    const res  = await http.get(SHEET_URL);
    const data = res.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') return Object.values(data);
    return [];
}

async function guardarEnSheets(payload) {
    await http.post(SHEET_URL, payload);
}

async function actualizarEstado(id, estado) {
    await http.post(SHEET_URL, { action: 'update', id, estado });
}

async function obtenerProximoId() {
    try {
        const tickets  = await obtenerTickets();
        if (!tickets.length) return 'TI-0001';
        const numeros  = tickets
            .map(t => parseInt((t.id || '').replace('TI-', ''), 10))
            .filter(n => !isNaN(n));
        const siguiente = numeros.length ? Math.max(...numeros) + 1 : 1;
        return 'TI-' + String(siguiente).padStart(4, '0');
    } catch {
        return 'TI-' + Date.now();
    }
}

// ─── Filtro tolerante de tickets ──────────────────────────────────────────────
// Usa userId si el ticket lo tiene; si no (tickets viejos), usa el nombre.
function ticketsDeUsuario(tickets, userId, userName) {
    return tickets.filter(t => {
        const tieneId = t.userId !== undefined && t.userId !== null && t.userId !== '';
        if (tieneId) return String(t.userId).trim() === String(userId).trim();
        return String(t.usuario || '').trim() === String(userName || '').trim();
    });
}

// ─── Validación de texto ──────────────────────────────────────────────────────
const MAX_CHARS = 500;
function validarTexto(text) {
    if (!text || text.trim().length === 0) return '⚠️ El campo no puede estar vacío.';
    if (text.length > MAX_CHARS) return `⚠️ Máximo ${MAX_CHARS} caracteres (recibiste ${text.length}).`;
    return null;
}

// ─── Notificar al grupo ───────────────────────────────────────────────────────
async function notificarGrupo(ticket) {
    if (!GRUPO_ID) return;
    const msg =
        `🆕 *Nuevo ticket*\n\n` +
        `🎫 ${ticket.id}\n📌 ${ticket.tipo}\n🏢 ${ticket.sucursal}\n` +
        `👤 ${ticket.reportante}\n📝 ${ticket.descripcion}\n` +
        `⚡ ${ticket.prioridad}\n👁 ${ticket.usuario}`;
    try {
        await bot.sendMessage(GRUPO_ID, msg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('[GRUPO]', e.message);
    }
}

// ─── Teclado principal ────────────────────────────────────────────────────────
const TECLADO_PRINCIPAL = {
    keyboard: [
        ['🎫 Nuevo Ticket'],
        ['📋 Mis Tickets', '🗂 Historial'],
        // FIX #1 — Botón Cancelar visible en el teclado, no solo como inline ni solo como /cancelar
        ['❌ Cancelar Ticket', '❓ Ayuda'],
    ],
    resize_keyboard: true,
};

// ─── Iniciar ticket ───────────────────────────────────────────────────────────
function iniciarTicket(chatId) {
    if (usuarios[chatId]) {
        return bot.sendMessage(
            chatId,
            '⚠️ Ya tienes un ticket en proceso. Usa ❌ *Cancelar Ticket* para descartarlo.',
            { parse_mode: 'Markdown' }
        );
    }
    crearSesion(chatId, { paso: 'tipo' });
    bot.sendMessage(chatId, '🛠 Selecciona el tipo de problema:', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🌐 Red',       callback_data: 'tipo__Red' }],
                [{ text: '🖨 Impresora', callback_data: 'tipo__Impresora' }],
                [{ text: '💻 Sistema',   callback_data: 'tipo__Sistema' }],
                [{ text: '📹 Cámaras',   callback_data: 'tipo__Camaras' }],
            ],
        },
    });
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '👋 Bienvenido al sistema de soporte TI', {
        reply_markup: TECLADO_PRINCIPAL,
    });
});

bot.onText(/\/nuevo/,    (msg) => iniciarTicket(msg.chat.id));
bot.onText(/\/cancelar/, (msg) => cancelarSesion(msg.chat.id));

function cancelarSesion(chatId) {
    if (usuarios[chatId]) {
        delete usuarios[chatId];
        bot.sendMessage(chatId, '❌ Ticket cancelado.', { reply_markup: TECLADO_PRINCIPAL });
    } else {
        bot.sendMessage(chatId, 'No tienes ningún ticket en proceso.');
    }
}

// ─── CALLBACKS ────────────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data   = query.data;

    await bot.answerCallbackQuery(query.id);

    // ── Confirmar ticket ──
    if (data === 'confirmar') {
        return guardarTicket(chatId, query.from);
    }

    // ── Cancelar ticket (botón inline en el resumen) ──
    if (data === 'cancelar') {
        delete usuarios[chatId];
        return bot.sendMessage(chatId, '❌ Ticket cancelado.', { reply_markup: TECLADO_PRINCIPAL });
    }

    // ── FIX #3: Solicitar cambio de estado ───────────────────────────────────
    // El ticketId viaja en el callback_data, NO en la sesión.
    // Formato: "estado__TI-0001"  →  split por '__' da ['estado', 'TI-0001']
    if (data.startsWith('estado__')) {
        const ticketId = data.split('__')[1];

        try {
            const tickets = await obtenerTickets();
            const ticket  = tickets.find(t => String(t.id).trim() === String(ticketId).trim());

            if (!ticket) {
                return bot.sendMessage(chatId, '❌ Ticket no encontrado.');
            }

            // Solo bloquear si el ticket tiene userId y no coincide con el solicitante
            const tieneUserId = ticket.userId !== undefined && ticket.userId !== null && ticket.userId !== '';
            if (tieneUserId && String(ticket.userId).trim() !== String(userId).trim()) {
                return bot.sendMessage(chatId, '⛔ No tienes permiso para modificar este ticket.');
            }
        } catch (e) {
            console.error('[ESTADO]', e);
            return bot.sendMessage(chatId, '❌ Error al verificar el ticket.');
        }

        // FIX #3: pasamos el ticketId directamente en el callback_data del siguiente paso,
        // sin depender de la sesión para no perderlo si expiró.
        return bot.sendMessage(chatId, `🔄 Nuevo estado para *${ticketId}*:`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🟡 En proceso', callback_data: `setestado__En proceso__${ticketId}` }],
                    [{ text: '🟢 Cerrado',    callback_data: `setestado__Cerrado__${ticketId}` }],
                ],
            },
        });
    }

    // ── FIX #3: Aplicar nuevo estado ─────────────────────────────────────────
    // Formato: "setestado__En proceso__TI-0001"
    // split('__') → ['setestado', 'En proceso', 'TI-0001']
    if (data.startsWith('setestado__')) {
        const partes      = data.split('__');
        const nuevoEstado = partes[1];   // "En proceso" o "Cerrado"
        const ticketId    = partes[2];   // "TI-0001"

        if (!ticketId || !nuevoEstado) {
            return bot.sendMessage(chatId, '❌ Datos inválidos. Intenta de nuevo.');
        }

        try {
            await actualizarEstado(ticketId, nuevoEstado);
            bot.sendMessage(
                chatId,
                `✅ Ticket *${ticketId}* actualizado a: *${nuevoEstado}*`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) {
            console.error('[SETESTADO]', e);
            bot.sendMessage(chatId, '❌ Error al actualizar el estado. Intenta más tarde.');
        }
        return;
    }

    // ── Flujo de creación — requiere sesión activa ────────────────────────────
    if (!usuarios[chatId]) return;

    if (data.startsWith('tipo__')) {
        actualizarSesion(chatId, { tipo: data.split('__')[1], paso: 'sucursal' });
        return bot.sendMessage(chatId, '🏢 ¿En qué sucursal ocurre el problema?');
    }

    if (data.startsWith('prioridad__')) {
        const prioridad = data.split('__')[1];
        actualizarSesion(chatId, { prioridad, paso: 'confirmacion' });

        const u = usuarios[chatId];
        const resumen =
            `📋 *Resumen del ticket*\n\n` +
            `👤 Telegram: ${query.from.first_name}\n` +
            `📌 Tipo: ${u.tipo}\n` +
            `🏢 Sucursal: ${u.sucursal}\n` +
            `👤 Reporta: ${u.reportante}\n` +
            `📝 Descripción: ${u.descripcion}\n` +
            `⚡ Prioridad: ${prioridad}`;

        return bot.sendMessage(chatId, resumen, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Confirmar', callback_data: 'confirmar' }],
                    [{ text: '❌ Cancelar',  callback_data: 'cancelar' }],
                ],
            },
        });
    }
});

// ─── MENSAJES ─────────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text   = msg.text;

    if (!text) return;
    if (text.startsWith('/')) return;

    if (text.includes('Nuevo Ticket')) return iniciarTicket(chatId);

    // FIX #1 — Cancelar desde el teclado principal
    if (text.includes('Cancelar Ticket')) return cancelarSesion(chatId);

    // ── Mis Tickets ──
    if (text.includes('Mis Tickets')) {
        try {
            const tickets = await obtenerTickets();
            console.log(`[DEBUG] Mis Tickets | userId: ${userId} | nombre: ${msg.from.first_name} | total: ${tickets.length}`);
            if (tickets[0]) console.log(`[DEBUG] ticket[0]:`, JSON.stringify(tickets[0]));

            const lista = ticketsDeUsuario(tickets, userId, msg.from.first_name)
                .filter(t => t.estado !== 'Cerrado')
                .slice(-5);

            console.log(`[DEBUG] Activos encontrados: ${lista.length}`);

            if (!lista.length) {
                return bot.sendMessage(chatId, '📭 No tienes tickets activos.');
            }
            for (const t of lista) {
                await bot.sendMessage(
                    chatId,
                    `🎫 *${t.id}*\n📌 ${t.tipo}\n🏢 ${t.sucursal}\n👤 ${t.reportante}\n⚡ ${t.prioridad}\n📊 ${t.estado}`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 Cambiar estado', callback_data: 'estado__' + t.id },
                            ]],
                        },
                    }
                );
            }
        } catch (e) {
            console.error('[MIS TICKETS]', e);
            bot.sendMessage(chatId, '❌ Error al obtener tickets. Intenta más tarde.');
        }
        return;
    }

    // FIX #2 — Historial con includes() para tolerar variantes Unicode del emoji 🗂
    if (text.includes('Historial')) {
        try {
            const tickets = await obtenerTickets();
            console.log(`[DEBUG] Historial | userId: ${userId} | total: ${tickets.length}`);

            const lista = ticketsDeUsuario(tickets, userId, msg.from.first_name).slice(-10);
            console.log(`[DEBUG] Historial encontrado: ${lista.length}`);

            if (!lista.length) {
                return bot.sendMessage(chatId, '📭 No tienes historial de tickets.');
            }
            for (const t of lista) {
                await bot.sendMessage(
                    chatId,
                    `🎫 *${t.id}*\n📌 ${t.tipo}\n🏢 ${t.sucursal}\n👤 ${t.reportante}\n⚡ ${t.prioridad}\n📊 ${t.estado}`,
                    { parse_mode: 'Markdown' }
                );
            }
        } catch (e) {
            console.error('[HISTORIAL]', e);
            bot.sendMessage(chatId, '❌ Error al obtener historial. Intenta más tarde.');
        }
        return;
    }

    if (text.includes('Ayuda')) {
        return bot.sendMessage(
            chatId,
            '📖 *Ayuda*\n\n' +
            '🎫 *Nuevo Ticket* — Abre un nuevo ticket\n' +
            '📋 *Mis Tickets* — Tickets activos\n' +
            '🗂 *Historial* — Todos tus tickets\n' +
            '❌ *Cancelar Ticket* — Cancela el ticket en proceso\n' +
            '/cancelar — Igual que el botón de cancelar',
            { parse_mode: 'Markdown' }
        );
    }

    // ── Flujo de creación ──
    if (!usuarios[chatId]) return;

    const estado = usuarios[chatId];

    if (['tipo', 'prioridad', 'confirmacion'].includes(estado.paso)) {
        return bot.sendMessage(chatId, '⬆️ Usa los botones de arriba para continuar.');
    }

    if (estado.paso === 'sucursal') {
        const err = validarTexto(text);
        if (err) return bot.sendMessage(chatId, err);
        actualizarSesion(chatId, { sucursal: text.trim(), paso: 'reportante' });
        return bot.sendMessage(chatId, '👤 ¿Quién reporta el problema?');
    }

    if (estado.paso === 'reportante') {
        const err = validarTexto(text);
        if (err) return bot.sendMessage(chatId, err);
        actualizarSesion(chatId, { reportante: text.trim(), paso: 'descripcion' });
        return bot.sendMessage(chatId, '📝 Describe el problema con detalle:');
    }

    if (estado.paso === 'descripcion') {
        const err = validarTexto(text);
        if (err) return bot.sendMessage(chatId, err);
        actualizarSesion(chatId, { descripcion: text.trim(), paso: 'prioridad' });
        return bot.sendMessage(chatId, '⚡ Selecciona la prioridad:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔴 Alta',  callback_data: 'prioridad__Alta' }],
                    [{ text: '🟡 Media', callback_data: 'prioridad__Media' }],
                    [{ text: '🟢 Baja',  callback_data: 'prioridad__Baja' }],
                ],
            },
        });
    }
});

// ─── GUARDAR TICKET ───────────────────────────────────────────────────────────
async function guardarTicket(chatId, user) {
    try {
        const id = await obtenerProximoId();
        const d  = usuarios[chatId];

        const ticket = {
            id,
            fecha:       new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }),
            userId:      user.id,
            usuario:     user.first_name,
            tipo:        d.tipo,
            sucursal:    d.sucursal,
            reportante:  d.reportante,
            descripcion: d.descripcion,
            prioridad:   d.prioridad,
            estado:      'Abierto',
        };

        await guardarEnSheets(ticket);

        bot.sendMessage(
            chatId,
            `✅ *Ticket creado*\n\n🎫 ID: *${id}*\n📊 Estado: Abierto`,
            { parse_mode: 'Markdown', reply_markup: TECLADO_PRINCIPAL }
        );

        await notificarGrupo(ticket);
        delete usuarios[chatId];
    } catch (e) {
        console.error('[GUARDAR]', e);
        bot.sendMessage(chatId, '❌ Error al guardar el ticket. Intenta de nuevo.');
    }
}

console.log('🤖 Bot iniciado correctamente');
