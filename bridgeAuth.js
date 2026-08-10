// Credencial del equipo (Opción B) — el bridge deja de leer con la anon key.
//
// ## Qué problema resuelve
// Antes se configuraba pegando el `business_id` y se leía con la anon key. Ese UUID no es
// secreto —viaja al navegador de cualquiera que abra el menú público— así que era, de facto,
// la única credencial. Ahora el dueño inicia sesión UNA vez, este equipo recibe un token
// propio (`brg_…`) de SOLO LECTURA y revocable, y la sesión del dueño se descarta: nunca
// queda un refresh token suyo en la PC del mostrador.
//
// ## Qué guarda y cómo
// Solo el `brg_`, cifrado con `safeStorage` (Keychain en macOS, DPAPI en Windows). El JWT de
// 60 minutos vive en memoria: no se persiste nada que caduque.
//
// ## Qué NO hace
// No imprime ni sabe imprimir. Y el camino HTTP del POS (POST a localhost) no pasa por acá:
// si esta credencial falla, cobrar sigue imprimiendo — solo se pierde la auto-impresión de
// los pedidos que entran del menú digital.

const { safeStorage } = require('electron')

const API_BASE = process.env.TITIMENU_API_BASE || 'https://www.titimenu.com'
const SUPABASE_URL = 'https://rurxexgoamhhgwhvzpgn.supabase.co'

// Se renueva ANTES de que expire (el JWT dura 60 min): si se espera al vencimiento, los
// canales de realtime se caen con un token viejo y el fallo es silencioso.
const RENEW_AFTER_MS = 45 * 60 * 1000
// Backoff de reintento: un fallo de red NO invalida la credencial, solo se espera.
const RETRY_MS = [30_000, 60_000, 300_000]

const KEY_TOKEN = 'bridgeDeviceToken'      // ciphertext base64 del brg_
const KEY_DEVICE = 'bridgeDeviceMeta'

let store = null
let onLog = () => {}
let onState = () => {}

// Estado en memoria
let jwt = null
let business = null
let renewTimer = null
let retryIndex = 0

function log(msg) { onLog(msg); console.log('[bridgeAuth]', msg) }

function init({ store: s, logger, stateChange }) {
  store = s
  onLog = logger || (() => {})
  onState = stateChange || (() => {})
}

// ── Guardado del token ────────────────────────────────────────────────────────
// safeStorage puede no estar disponible (Linux sin keyring). En ese caso NO se persiste un
// token del negocio en texto plano: se pide iniciar sesión en cada arranque. Es menos cómodo
// y es la decisión correcta — un secreto en claro en el disco del mostrador no vale la
// comodidad de no volver a escribir la contraseña.
function encryptionAvailable() {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

function saveToken(token) {
  if (encryptionAvailable()) {
    store.set(KEY_TOKEN, safeStorage.encryptString(token).toString('base64'))
    return { persisted: true }
  }
  // Sin cifrado del SO: se queda solo en memoria de este proceso.
  store.delete(KEY_TOKEN)
  log('safeStorage no disponible: la credencial NO se guarda en disco (habrá que iniciar sesión al reabrir)')
  return { persisted: false }
}

let tokenInMemory = null

function readToken() {
  if (tokenInMemory) return tokenInMemory
  const raw = store.get(KEY_TOKEN)
  if (!raw || !encryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'))
  } catch (e) {
    // Cambió el usuario del SO, se migró la PC, o el keychain se reinicializó.
    log(`no se pudo descifrar la credencial guardada (${e.message}) — hay que iniciar sesión otra vez`)
    store.delete(KEY_TOKEN)
    return null
  }
}

function forgetToken(reason) {
  tokenInMemory = null
  store.delete(KEY_TOKEN)
  store.delete(KEY_DEVICE)
  jwt = null
  log(`credencial borrada: ${reason}`)
  onState({ kind: 'needs-login', reason })
}

function hasCredential() { return !!readToken() }
function getBusiness() { return business }
function getJwt() { return jwt }

// ── Registro: la sesión del dueño se usa UNA vez y se descarta ────────────────

/**
 * Inicia sesión con las credenciales del dueño SOLO para registrar este equipo.
 * Devuelve la lista de negocios si tiene más de uno (el selector de la UI).
 */
async function signInOwner(email, password) {
  const { createClient } = require('@supabase/supabase-js')
  const anon = require('./supabase').ANON_KEY
  // persistSession:false a propósito: esta sesión no debe sobrevivir al registro.
  const client = createClient(SUPABASE_URL, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data?.session) {
    return { ok: false, error: 'Correo o contraseña incorrectos.' }
  }
  const accessToken = data.session.access_token
  const { data: rows, error: bizErr } = await client
    .from('businesses').select('id, name').eq('owner_id', data.user.id).order('name')

  if (bizErr) return { ok: false, error: 'No pudimos leer tus negocios.' }
  if (!rows || rows.length === 0) {
    // Staff: su usuario existe pero no es dueño de ningún negocio (decisión: v1 solo dueño).
    await client.auth.signOut()
    return { ok: false, error: 'Esta cuenta no es la del dueño de un negocio. Pídele al dueño que conecte este equipo.' }
  }
  return { ok: true, accessToken, businesses: rows, client }
}

/**
 * Registra el equipo contra el negocio elegido y guarda la credencial.
 * `session.client` se cierra aquí: fin de la sesión del dueño en esta PC.
 */
async function registerDevice({ accessToken, client }, businessId, deviceName) {
  try {
    const res = await fetch(`${API_BASE}/api/bridge/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ businessId, deviceName }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.token) {
      return { ok: false, error: body.error || 'No se pudo conectar este equipo.' }
    }
    tokenInMemory = body.token
    const { persisted } = saveToken(body.token)
    store.set(KEY_DEVICE, { id: body.device?.id, name: body.device?.name, businessId })
    log(`equipo registrado: ${body.device?.name} (${persisted ? 'credencial guardada' : 'solo en memoria'})`)
    return { ok: true, device: body.device, business: body.business, persisted }
  } finally {
    // Pase lo que pase, la sesión del dueño no se queda viva.
    try { await client.auth.signOut() } catch {}
  }
}

// ── Canje del token por el JWT corto, con renovación ─────────────────────────

/**
 * Canjea la credencial por un JWT de 60 min. Distingue los dos fallos que NO son iguales:
 * red caída (se reintenta, la credencial sigue valiendo) vs. equipo revocado (se borra).
 */
async function exchange() {
  const token = readToken()
  if (!token) { onState({ kind: 'needs-login', reason: 'sin credencial' }); return null }

  try {
    const res = await fetch(`${API_BASE}/api/bridge/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}))
      // El servidor dijo explícitamente que este equipo no está autorizado. NO se afirma
      // "revocado": el endpoint responde igual para revocado y para inexistente (a propósito,
      // para no confirmarle a quien prueba tokens que acertó uno), así que el bridge no puede
      // distinguirlos y no debe inventar la causa.
      forgetToken('este equipo ya no está autorizado — hay que conectarlo otra vez')
      return null
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const body = await res.json()
    jwt = body.jwt
    business = body.business || business
    retryIndex = 0
    scheduleRenew(RENEW_AFTER_MS)
    log(`credencial canjeada — negocio "${business?.name}", vence en ${Math.round((body.expiresIn || 0) / 60)} min`)
    onState({ kind: 'ready', business })
    return jwt
  } catch (e) {
    // Sin internet, Vercel desplegando, DNS… NO se toca la credencial.
    const wait = RETRY_MS[Math.min(retryIndex, RETRY_MS.length - 1)]
    retryIndex++
    log(`no se pudo renovar la credencial (${e.message}) — reintento en ${wait / 1000}s`)
    onState({ kind: 'offline', retryInMs: wait })
    scheduleRenew(wait)
    return null
  }
}

function scheduleRenew(ms) {
  if (renewTimer) clearTimeout(renewTimer)
  renewTimer = setTimeout(() => { exchange().catch(() => {}) }, ms)
}

function stop() {
  if (renewTimer) clearTimeout(renewTimer)
  renewTimer = null
  jwt = null
}

module.exports = {
  init, signInOwner, registerDevice, exchange, stop,
  hasCredential, getJwt, getBusiness, forgetToken, encryptionAvailable,
}
