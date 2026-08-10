const { createClient } = require('@supabase/supabase-js')
const ws = require('ws')

const SUPABASE_URL = 'https://rurxexgoamhhgwhvzpgn.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1cnhleGdvYW1oaGd3aHZ6cGduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTQ1MjIsImV4cCI6MjA4OTU5MDUyMn0.j4MuabUJ0FIjyPQbH4v2BokDNmOnFBQnNELxH8OEjcg'

// Global reference — prevents garbage collection
let supabase = null
let channels = []
let heartbeatTimer = null
let reconnectTimer = null
let isConnected = false
// JWT del equipo en uso. La reconexión crea un socket nuevo, que nace SIN identidad: si no
// se vuelve a imponer, los canales se unen como anon y hoy colarían por la política abierta
// (mañana, cerrada, no traerían nada). Un getter lo mantiene fresco tras cada renovación.
let jwtProvider = () => null
let onStatusChange = null
let onNewOrder = null
let onLog = null

function log(msg) {
  if (onLog) onLog(msg)
  console.log('[supabase]', msg)
}

function getClient() {
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: {
        transport: ws,
        timeout: 30000,
        params: {
          heartbeatIntervalMs: 15000,
          eventsPerSecond: 10
        }
      }
    })
  }
  return supabase
}

function setCallbacks({ onStatus, onOrder, onLogger }) {
  onStatusChange = onStatus
  onNewOrder = onOrder
  onLog = onLogger || null
}

function setStatus(connected) {
  isConnected = connected
  if (onStatusChange) onStatusChange(connected)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function startHeartbeat(client) {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    try {
      // Pinging realtime socket to keep connection alive
      client.realtime.sendHeartbeat()
    } catch (_) {}
  }, 20000)
}

function stopChannels() {
  stopHeartbeat()
  const client = getClient()
  channels.forEach(ch => {
    try { client.removeChannel(ch) } catch (_) {}
  })
  channels = []
}

function startListening(businessId, deviceJwt) {
  // Si llega un getter, se guarda; si llega un string, se envuelve.
  if (typeof deviceJwt === 'function') jwtProvider = deviceJwt
  else if (deviceJwt) jwtProvider = () => deviceJwt
  stopChannels()
  clearTimeout(reconnectTimer)

  log('Conectando a Supabase...')

  const client = getClient()

  // Identidad del EQUIPO, no la anon key: el JWT lleva role=bridge_reader y el business_id
  // en un claim, y las políticas bridge_read_* resuelven por ese claim. Sin esto el bridge
  // leería por la política abierta (anon_select_pos_orders, USING true) — el agujero que
  // este cambio existe para cerrar.
  //
  // Va ANTES de suscribir: un canal que se une con el token viejo no se re-autentica solo, y
  // el modo de fallo es el peor —silencioso—, así que el orden importa.
  const token = jwtProvider()
  if (token) {
    client.realtime.setAuth(token)
  } else {
    log('SIN credencial de equipo: los pedidos del menú no se imprimirán solos')
  }

  let subscribedCount = 0

  function onChannelSubscribed(channelName) {
    log(`Suscrito a ${channelName}`)
    subscribedCount++
    if (subscribedCount === 2) {
      setStatus(true)
      clearTimeout(reconnectTimer)
      startHeartbeat(client)
      log('Esperando órdenes...')
    }
  }

  function onChannelError(channelName, status) {
    // Only react to the first error to avoid double reconnect
    if (!isConnected && channels.length === 0) return
    log(`Canal ${channelName} cerrado (${status}) — reintentando en 5s...`)
    stopChannels()
    setStatus(false)
    scheduleReconnect(businessId)
  }

  // Channel 1: pos_orders
  const posChannel = client
    .channel(`pos_orders:${businessId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'pos_orders',
        filter: `business_id=eq.${businessId}`
      },
      (payload) => {
        log('Orden POS recibida — imprimiendo...')
        if (onNewOrder) onNewOrder('pos', payload.new)
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        onChannelSubscribed('pos_orders')
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        onChannelError('pos_orders', status)
      }
    })

  // Channel 2: orders (mesas + delivery/takeout)
  const tableChannel = client
    .channel(`orders_table:${businessId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'orders',
        filter: `business_id=eq.${businessId}`
      },
      (payload) => {
        const orderType = payload.new.order_type
        if (!orderType || orderType === 'table') {
          log('Orden de mesa recibida — imprimiendo...')
          if (onNewOrder) onNewOrder('table', payload.new)
        } else if (orderType === 'delivery' || orderType === 'takeout') {
          log(`Orden ${orderType} recibida — imprimiendo...`)
          if (onNewOrder) onNewOrder('delivery', payload.new)
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        onChannelSubscribed('orders')
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        onChannelError('orders', status)
      }
    })

  channels = [posChannel, tableChannel]
}

// OJO: al reconectar hay que volver a imponer el JWT (lo pasa el caller desde bridgeAuth):
// el socket nuevo nace sin identidad.
function scheduleReconnect(businessId) {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    // jwtProvider se consulta de nuevo adentro: si el token se renovó mientras estábamos
    // caídos, la reconexión entra con el vigente y no con el que expiró.
    startListening(businessId)
  }, 5000)
}

function disconnect() {
  clearTimeout(reconnectTimer)
  stopChannels()
  setStatus(false)
}

// REGLA (aprendida a golpes): con RLS, una consulta puede devolver CERO filas sin
// error — `data: null, error: null`. Un `catch` o un `|| {}` la convierte en un vacío
// indistinguible de "no hay datos", y el fallo queda invisible en los logs. Esto costó
// dos rondas de arreglos con el cajero: el bridge usa la anon key SIN sesión, así que
// toda tabla con política por `auth.uid()` le responde vacío. Si una consulta vuelve
// vacía sin error, hay que decirlo y nombrar la sospecha.
function warnIfEmpty(label, { data, error }) {
  if (error) {
    console.warn(`[${label}] error de consulta: ${error.message}`)
  } else if (data == null) {
    console.warn(`[${label}] 0 filas sin error — sospecha RLS: este cliente usa la anon key sin sesión (auth.uid() = NULL)`)
  }
  return data
}

// NOTA: aquí vivía fetchBusinessInfo(), que leía `businesses` con la anon key. Se eliminó al
// pasar a la credencial de equipo: los datos del negocio (nombre, RNC, moneda, flags del
// desglose) los devuelve el canje en /api/bridge/session, así que el bridge NO consulta
// ninguna tabla por REST. Su superficie completa es SELECT por realtime sobre pos_orders y
// orders, y el JWT del equipo no tiene grant para nada más — verificado: products,
// businesses y bridge_devices responden 403 permission denied.

module.exports = { ANON_KEY: SUPABASE_ANON_KEY, getClient, setCallbacks, startListening, disconnect, isConnected: () => isConnected, warnIfEmpty }
