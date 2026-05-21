const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = 'https://rurxexgoamhhgwhvzpgn.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1cnhleGdvYW1oaGd3aHZ6cGduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDIzNzIyMzAsImV4cCI6MjA1Nzk0ODIzMH0.7jfwHFJwqEjxHQhwb1pMgUfrgI9k1pNZnMPGSijI-zk'

let supabase = null
let channels = []
let reconnectTimer = null
let isConnected = false
let onStatusChange = null
let onNewOrder = null

function getClient() {
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: {
        params: { eventsPerSecond: 10 }
      }
    })
  }
  return supabase
}

function setCallbacks({ onStatus, onOrder }) {
  onStatusChange = onStatus
  onNewOrder = onOrder
}

function setStatus(connected) {
  isConnected = connected
  if (onStatusChange) onStatusChange(connected)
}

function stopChannels() {
  const client = getClient()
  channels.forEach(ch => {
    try { client.removeChannel(ch) } catch (_) {}
  })
  channels = []
}

function startListening(businessId) {
  stopChannels()
  clearTimeout(reconnectTimer)

  const client = getClient()

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
        if (onNewOrder) onNewOrder('pos', payload.new)
      }
    )
    .subscribe((status) => handleSubscribeStatus(status, businessId))

  // Channel 2: orders - mesas
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
          if (onNewOrder) onNewOrder('table', payload.new)
        } else if (orderType === 'delivery' || orderType === 'takeout') {
          if (onNewOrder) onNewOrder('delivery', payload.new)
        }
      }
    )
    .subscribe((status) => handleSubscribeStatus(status, businessId))

  channels = [posChannel, tableChannel]
}

function handleSubscribeStatus(status, businessId) {
  if (status === 'SUBSCRIBED') {
    setStatus(true)
    clearTimeout(reconnectTimer)
  } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
    setStatus(false)
    scheduleReconnect(businessId)
  }
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

module.exports = { getClient, setCallbacks, startListening, disconnect, isConnected: () => isConnected }
