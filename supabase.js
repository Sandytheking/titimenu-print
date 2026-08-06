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

function startListening(businessId) {
  stopChannels()
  clearTimeout(reconnectTimer)

  log('Conectando a Supabase...')

  const client = getClient()

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

function scheduleReconnect(businessId) {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
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

async function fetchBusinessInfo(businessId) {
  try {
    const client = getClient()
    const res = await client
      .from('businesses')
      .select('id, name, currency, rnc, legal_name, address')
      .eq('id', businessId)
      .single()
    return warnIfEmpty('businesses', res) || {}
  } catch (e) {
    console.warn('[businesses] excepción al leer el negocio:', e.message)
    return {}
  }
}

module.exports = { getClient, setCallbacks, startListening, disconnect, isConnected: () => isConnected, fetchBusinessInfo, warnIfEmpty }
