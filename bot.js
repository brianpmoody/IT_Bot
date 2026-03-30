require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const token = process.env.TOKEN;
const SHEET_URL = process.env.SHEET_URL;
const GRUPO_ID = process.env.GRUPO_ID;

const bot = new TelegramBot(token, { polling: true });

// ─── Health check (para plataformas como Render/Railway) ──────────────────────
require('http').createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
}).listen(process.env.PORT || 3000);

// ─── Estado en memoria ────────────────────────────────────────────────────────
let usuarios = {};
const SESSION_TTL = 30 * 60 * 1000; // 30 minutos

// Limpia sesiones expiradas cada 10 minutos
setInterval(() => {
    const ahora = Date.now();
    for (const chatId in usuarios) {
        if (ahora - usuarios[chatId].timestamp > SESSION_TTL) {
            delete usuarios[chatId];
            console.log(`Sesión expirada eliminada: ${chatId}`);
        }
    }
}, 10 * 60 * 1000);

// ─── Helpers de sesión ────────────────────────────────────────────────────────
function crearSesion(chatId, datos = {}) {
    usuarios[chatId] = { ...datos, timestamp: Date.now() };
}

function actualizarSesion(chatId, datos = {}) {
    if (usuarios[chatId]) {
        usuarios[chatId] = { ...usuarios[chatId], ...datos, timestamp: Date.now() };
    }
}

// ─── API Google Sheets ────────────────────────────────────────────────────────
const axiosInstance = axios.create({ timeout: 5000 });

async function obtenerTickets() {
    const res = await axiosInstance.get(SHEET_URL);
    // Sheets a veces devuelve un objeto en vez de array — normalizamos siempre
    const data = res.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') return Object.values(data);
    return [];
}

// Busca los tickets de un usuario de forma tolerante:
// 1) Si el ticket tiene userId → compara por ID numérico (robusto)
// 2) Si el ticket es viejo y no tiene userId → cae a comparar por nombre (compatibilidad)
function ticketsDeUsuario(tickets, userId, userName) {
    return tickets.filter(t => {
        if (t.userId !== undefined && t.userId !== null && t.userId !== '') {
            return String(t.userId).trim() === String(userId).trim();
        }
        // Compatibilidad con tickets guardados antes del fix
        return String(t.usuario || '').trim() === String(userName || '').trim();
    });
}

async function guardarEnSheets(payload) {
    await axiosInstance.post(SHEET_URL, payload);
}

// FIX #4 — Genera el próximo ID consultando el contador real en Sheets
async function obtenerProximoId() {
    try {
        const tickets = await obtenerTickets();
        if (!Array.isArray(tickets) || tickets.length === 0) return 'TI-0001';
        // Extrae el número más alto de los IDs existentes
        const numeros = tickets
            .map(t => parseInt((t.id || '').replace('TI-', ''), 10))
            .filter(n => !isNaN(n));
        const siguiente = numeros.length > 0 ? Math.max(...numeros) + 1 : 1;
        return 'TI-' + String(siguiente).padStart(4, '0');
    } catch {
        // Si falla la lectura, usa timestamp como fallback seguro
        return 'TI-' + Date.now();
    }
}

// FIX #6 — actualizarEstado con manejo de errores
async function actualizarEstado(id, estado) {
    await axiosInstance.post(SHEET_URL, { action: 'update', id, estado });
}

// ─── Validaciones ─────────────────────────────────────────────────────────────
const MAX_CHARS = 500;

function validarTexto(text) {
    if (!text || text.trim().length === 0) return '⚠️ El campo no puede estar vacío.';
    if (text.length > MAX_CHARS) return `⚠️ Máximo ${MAX_CHARS} caracteres (recibí ${text.length}).`;
    return null;
}

// ─── Notificación al grupo ────────────────────────────────────────────────────
async function notificarGrupo(ticket) {
    if (!GRUPO_ID) return;
    const msg =
        `🆕 *Nuevo ticket creado*\n\n` +
        `🎫 ID: ${ticket.id}\n` +
        `📌 Tipo: ${ticket.tipo}\n` +
        `🏢 Sucursal: ${ticket.sucursal}\n` +
        `👤 Reporta: ${ticket.reportante}\n` +
        `📝 ${ticket.descripcion}\n` +
        `⚡ Prioridad: ${ticket.prioridad}\n` +
        `👁 Usuario TG: ${ticket.usuario}`;
    try {
        await bot.sendMessage(GRUPO_ID, msg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Error al notificar al grupo:', e.message);
    }
}

// ─── Iniciar ticket ───────────────────────────────────────────────────────────
function iniciarTicket(chatId) {
    if (usuarios[chatId]) {
        return bot.sendMessage(chatId, '⚠️ Ya tienes un ticket en proceso. Complétalo o cancélalo primero.');
    }

    crearSesion(chatId, { paso: 'tipo' });

    bot.sendMessage(chatId, '🛠 Selecciona el tipo de problema:', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🌐 Red', callback_data: 'tipo__Red' }],
                [{ text: '🖨 Impresora', callback_data: 'tipo__Impresora' }],
                [{ text: '💻 Sistema', callback_data: 'tipo__Sistema' }],
                [{ text: '📹 Cámaras', callback_data: 'tipo__Camaras' }],
            ],
        },
    });
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '👋 Bienvenido al sistema de soporte TI', {
        reply_markup: {
            keyboard: [
                ['🎫 Nuevo Ticket'],
                ['📋 Mis Tickets', '🗂 Historial'],
                ['❓ Ayuda'],
            ],
            resize_keyboard: true,
        },
    });
});

bot.onText(/\/nuevo/, (msg) => iniciarTicket(msg.chat.id));

bot.onText(/\/cancelar/, (msg) => {
    const chatId = msg.chat.id;
    if (usuarios[chatId]) {
        delete usuarios[chatId];
        bot.sendMessage(chatId, '❌ Ticket cancelado.');
    } else {
        bot.sendMessage(chatId, 'No tienes ningún ticket en proceso.');
    }
});

// ─── CALLBACKS ────────────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id; // FIX #3 — usar ID numérico, no nombre
    const data = query.data;

    await bot.answerCallbackQuery(query.id);

    // ── Solicitar cambio de estado ──
    if (data.startsWith('estado__')) {
        const ticketId = data.split('__')[1];

        // FIX #7 — Verificar que el ticket pertenece al usuario
        try {
            const tickets = await obtenerTickets();
            const ticket = tickets.find(t => t.id === ticketId);

            if (!ticket) {
                return bot.sendMessage(chatId, '❌ Ticket no encontrado.');
            }
            if (String(ticket.userId) !== String(userId)) {
                return bot.sendMessage(chatId, '⛔ No tienes permiso para modificar este ticket.');
            }
        } catch (e) {
            console.error(e);
            return bot.sendMessage(chatId, '❌ Error al verificar el ticket.');
        }

        // FIX #2 — Guardar el ticketId en una clave separada, sin romper el flujo de sesión
        crearSesion(chatId, { paso: 'estado', ticketId });

        return bot.sendMessage(chatId, '🔄 Selecciona el nuevo estado:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🟡 En proceso', callback_data: 'setestado__En proceso' }],
                    [{ text: '🟢 Cerrado', callback_data: 'setestado__Cerrado' }],
                ],
            },
        });
    }

    // FIX #4 — split con doble guion para preservar espacios en el valor
    if (data.startsWith('setestado__')) {
        const nuevoEstado = data.split('__')[1]; // "En proceso" queda intacto
        const ticketId = usuarios[chatId]?.ticketId;

        if (!ticketId) {
            return bot.sendMessage(chatId, '❌ Sesión expirada. Intenta de nuevo.');
        }

        try {
            await actualizarEstado(ticketId, nuevoEstado);
            bot.sendMessage(chatId, `✅ Ticket *${ticketId}* actualizado a: *${nuevoEstado}*`, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, '❌ Error al actualizar el estado. Intenta más tarde.');
        }

        delete usuarios[chatId];
        return;
    }

    if (!usuarios[chatId]) return;

    // FIX #4 — separador doble en tipo__ para evitar colisión con valores compuestos
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
                    [{ text: '❌ Cancelar', callback_data: 'cancelar' }],
                ],
            },
        });
    }

    if (data === 'confirmar') {
        return guardarTicket(chatId, query.from);
    }

    if (data === 'cancelar') {
        delete usuarios[chatId];
        return bot.sendMessage(chatId, '❌ Ticket cancelado.');
    }
});

// ─── MENSAJES ─────────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id; // FIX #3 — ID único
    const text = msg.text;

    if (!text) return;
    if (text.startsWith('/')) return;

    if (text === '🎫 Nuevo Ticket') return iniciarTicket(chatId);

    // ── Mis Tickets (solo activos) ──
    if (text === '📋 Mis Tickets') {
        try {
            const tickets = await obtenerTickets();
            console.log(`[DEBUG] Total tickets en Sheets: ${tickets.length}`);
            console.log(`[DEBUG] userId buscado: ${userId} | userName: ${msg.from.first_name}`);
            if (tickets.length > 0) console.log(`[DEBUG] Primer ticket:`, JSON.stringify(tickets[0]));
            const lista = ticketsDeUsuario(tickets, userId, msg.from.first_name)
                .filter(t => t.estado !== 'Cerrado')
                .slice(-5);
            console.log(`[DEBUG] Tickets activos encontrados: ${lista.length}`);

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
                            inline_keyboard: [
                                [{ text: '🔄 Cambiar estado', callback_data: 'estado__' + t.id }],
                            ],
                        },
                    }
                );
            }
        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, '❌ Error al obtener tickets. Intenta más tarde.');
        }
        return;
    }

    // ── Historial ──
    if (text === '🗂 Historial') {
        try {
            const tickets = await obtenerTickets();
            console.log(`[DEBUG] Historial — Total tickets: ${tickets.length} | userId: ${userId}`);
            const lista = ticketsDeUsuario(tickets, userId, msg.from.first_name)
                .slice(-10);
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
            console.error(e);
            bot.sendMessage(chatId, '❌ Error al obtener historial. Intenta más tarde.');
        }
        return;
    }

    if (text === '❓ Ayuda') {
        return bot.sendMessage(
            chatId,
            '📖 *Comandos disponibles:*\n\n' +
            '🎫 *Nuevo Ticket* — Abre un ticket de soporte\n' +
            '📋 *Mis Tickets* — Ve tus tickets activos\n' +
            '🗂 *Historial* — Ve todos tus tickets\n' +
            '/cancelar — Cancela el ticket en proceso',
            { parse_mode: 'Markdown' }
        );
    }

    // ── Flujo de creación de ticket ──
    if (!usuarios[chatId]) return;

    const estado = usuarios[chatId];

    // FIX #5 — Ignorar texto si el paso actual espera un callback (no texto)
    if (estado.paso === 'tipo' || estado.paso === 'prioridad' || estado.paso === 'confirmacion') {
        return bot.sendMessage(chatId, '⬆️ Por favor usa los botones de arriba para continuar.');
    }

    if (estado.paso === 'sucursal') {
        const error = validarTexto(text);
        if (error) return bot.sendMessage(chatId, error);
        actualizarSesion(chatId, { sucursal: text.trim(), paso: 'reportante' });
        return bot.sendMessage(chatId, '👤 ¿Quién reporta el problema?');
    }

    if (estado.paso === 'reportante') {
        const error = validarTexto(text);
        if (error) return bot.sendMessage(chatId, error);
        actualizarSesion(chatId, { reportante: text.trim(), paso: 'descripcion' });
        return bot.sendMessage(chatId, '📝 Describe el problema con detalle:');
    }

    if (estado.paso === 'descripcion') {
        const error = validarTexto(text);
        if (error) return bot.sendMessage(chatId, error);
        actualizarSesion(chatId, { descripcion: text.trim(), paso: 'prioridad' });

        return bot.sendMessage(chatId, '⚡ Selecciona la prioridad:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔴 Alta', callback_data: 'prioridad__Alta' }],
                    [{ text: '🟡 Media', callback_data: 'prioridad__Media' }],
                    [{ text: '🟢 Baja', callback_data: 'prioridad__Baja' }],
                ],
            },
        });
    }
});

// ─── GUARDAR TICKET ───────────────────────────────────────────────────────────
async function guardarTicket(chatId, user) {
    try {
        // FIX #1 — El ID se genera desde Sheets, no desde un contador en memoria
        const id = await obtenerProximoId();
        const d = usuarios[chatId];

        const ticket = {
            id,
            fecha: new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }),
            userId: user.id,           // FIX #3 — guardar ID numérico único
            usuario: user.first_name,  // solo para display
            tipo: d.tipo,
            sucursal: d.sucursal,
            reportante: d.reportante,
            descripcion: d.descripcion,
            prioridad: d.prioridad,
            estado: 'Abierto',
        };

        await guardarEnSheets(ticket);

        bot.sendMessage(
            chatId,
            `✅ *Ticket creado exitosamente*\n\n🎫 ID: *${id}*\n📊 Estado: Abierto`,
            { parse_mode: 'Markdown' }
        );

        // FIX #8 — Ahora sí se usa GRUPO_ID para notificar
        await notificarGrupo(ticket);

        delete usuarios[chatId];
    } catch (e) {
        console.error('Error al guardar ticket:', e);
        bot.sendMessage(chatId, '❌ Error al guardar el ticket. Intenta de nuevo en unos momentos.');
    }
}

console.log('🤖 Bot iniciado correctamente');
