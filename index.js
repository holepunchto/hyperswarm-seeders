const DHT = require('@hyperswarm/dht')
const c = require('compact-encoding')
const { EventEmitter } = require('events')
const b4a = require('b4a')
const m = require('./messages')
const safetyCatch = require('safety-catch')

const RECORD_INTERVAL = 10 * 60 * 1000
const RECORD_JITTER = 3 * 60 * 1000

const RETRIES = [
  10000,
  30000,
  60000,
  2 * 60000,
  5 * 60000,
  20 * 60000,
  60 * 60000,
  120 * 60000
]

class MutableRecord {
  constructor (dht, seedKeyPair, keyPair, onchange) {
    if (b4a.isBuffer(seedKeyPair)) seedKeyPair = { publicKey: seedKeyPair }

    this.dht = dht
    this.seedKeyPair = seedKeyPair
    this.keyPair = keyPair
    this.value = null
    this.valueBuffer = null
    this.seq = -1
    this.latest = null
    this.timeout = null
    this.destroyed = false
    this.running = null
    this.onchange = onchange || (() => {})

    this._refreshBound = this._refresh.bind(this)
  }

  start (value) {
    const ann = !!value

    if (ann) {
      this.value = value
      this.valueBuffer = c.encode(m.record, value)
    }

    const update = async () => {
      this.running = this._run(ann)
      const updated = await this.running
      this.running = null

      if (!this.destroyed) {
        this.timeout = setTimeout(update, Math.floor(Math.random() * RECORD_JITTER + RECORD_INTERVAL))
      }

      return updated
    }

    return update()
  }

  async _run (announce) {
    try {
      return await (announce ? this._announce() : this._lookup())
    } catch {
      return false
    }
  }

  async destroy () {
    this.destroyed = true
    clearTimeout(this.timeout)
    await this.running
  }

  async _announce () {
    if (this.seq === -1) {
      this.latest = await this.dht.mutableGet(this.seedKeyPair.publicKey)
      this.seq = this.latest ? this.latest.seq + 1 : 0
    }

    const signMutable = (this.latest && this.latest.seq === this.seq) ? () => this.latest.signature : null
    const nodes = this.latest ? this.latest.closestNodes : null

    try {
      this.latest = await this.dht.mutablePut(this.seedKeyPair, this.valueBuffer, {
        seq: this.seq,
        signMutable,
        nodes
      })
    } catch {
      this.latest = null
      this.seq = -1
      return false
    }

    this.seq = this.latest.seq

    return true
  }

  async _lookup () {
    const nodes = this.latest ? this.latest.closestNodes : null

    await this.dht.mutableGet(this.seedKeyPair.publicKey, {
      nodes,
      refresh: this._refreshBound
    })
  }

  _refresh (latest) {
    const same = this.valueBuffer ? b4a.equals(latest.value, this.valueBuffer) : false

    try {
      this.value = c.decode(m.record, latest.value)
    } catch {
      return false
    }

    this.valueBuffer = latest.value

    this.latest = latest
    this.seq = latest.seq

    if (!same) {
      this.onchange(this.value)
    }

    for (const p of this.value.seeds) {
      if (b4a.equals(p, this.keyPair.publicKey)) {
        return true
      }
    }

    return false
  }
}

module.exports = class SeederSwarm extends EventEmitter {
  constructor (seedKeyPair, opts = {}) {
    super()

    if (b4a.isBuffer(seedKeyPair)) seedKeyPair = { publicKey: seedKeyPair }

    this.dht = opts.dht || new DHT()
    this.keyPair = opts.keyPair || this.dht.defaultKeyPair
    this.seedKeyPair = seedKeyPair
    this.record = null
    this.paused = false
    this.drop = false
    this.server = null
    this.clientConnections = 0
    this.clientConnecting = 0
    this.maxClientConnections = opts.maxClientConnections || 2
    this.connections = []

    this._neverListen = opts.server === false
    this._destroyDHT = !opts.dht
    this._pauseTimeout = null
    this._pending = 0
    this._flushes = []
    this._status = new Map()
  }

  get owner () {
    return b4a.equals(this.seedKeyPair.publicKey, this.keyPair.publicKey)
  }

  get seeder () {
    if (!this.record || !this.record.value) return false

    for (const pub of this.record.value.seeds) {
      if (b4a.equals(pub, this.keyPair.publicKey)) return true
    }

    return false
  }

  get seeds () {
    return this.record && this.record.value && this.record.value.seeds
  }

  get core () {
    return this.record && this.record.value && this.record.value.core
  }

  has (publicKey) {
    return !!this._get(publicKey)
  }

  _get (publicKey) {
    for (const c of this.connections) {
      if (b4a.equals(c.remotePublicKey, publicKey)) return c
    }
    return null
  }

  pause ({ timeout, drop } = {}) {
    if (timeout) {
      if (this._pauseTimeout) clearTimeout(this._pauseTimeout)
      this._pauseTimeout = setTimeout(pause, timeout, this, drop)
      return
    }

    this.paused = true
    this.drop = !!drop

    if (this.drop) {
      for (const c of this.connections) {
        c.destroy(new Error('Dropped due to paused swarm'))
      }
      for (const st of this._status.values()) {
        if (st.connection) {
          st.connection.destroy(new Error('Dropped due to paused swarm'))
        }
        if (st.timeout) {
          clearTimeout(st.timeout)
          st.timeout = null
        }

        st.tries = 0
      }
    }

    this._updateFlush(true)
  }

  resume () {
    this.paused = false
    this.drop = false
    if (this._pauseTimeout) clearTimeout(this._pauseTimeout)
    this._pauseTimeout = null

    this._connectToSeeds()
  }

  _fullClient () {
    return (this.clientConnections - this.clientConnecting) >= this.maxClientConnections
  }

  async flush () {
    await Promise.resolve() // wait a tick

    if (this._fullClient() || this.paused) return true
    if (this.record) await this.record.running
    if (this._fullClient() || this.paused || this._pending === 0) return true

    return new Promise(resolve => this._flushes.push(resolve))
  }

  _updateFlush (force) {
    if (force || this._fullClient() || this.paused || this._pending === 0) {
      while (this._flushes.length) {
        const resolve = this._flushes.pop()
        resolve(!force)
      }
    }
  }

  async destroy () {
    if (this._pauseTimeout) clearTimeout(this._pauseTimeout)
    for (const st of this._status) {
      if (st.timeout) clearTimeout(st.timeout)
      st.removed = true
      this._notPending(st)
    }
    this._status.clear()
    for (const c of this.connections) c.destroy()
    if (this.server) await this.server.close()
    if (this.record) await this.record.destroy()
    if (this._destroyDHT) await this.dht.destroy()
    this._updateFlush(true)
  }

  async join (record) {
    while (this.record) await this.leave()
    this.record = new MutableRecord(this.dht, this.seedKeyPair, this.keyPair, this._onupdate.bind(this))
    if (record) await this.listen()
    await this.record.start(record)
    if (record) this._onupdate()
  }

  async leave () {
    if (this.record) {
      const r = this.record
      await r.destroy()
      if (r === this.record) this.record = null
    }
  }

  listen () {
    if (this.server || this._neverListen) return Promise.resolve()

    this.server = this.dht.createServer((connection) => {
      const old = this._get(connection.remotePublicKey)

      if (old) {
        old.destroy(new Error('Duplicate connection')) // will dedup eventually, fine for now
      }

      const st = this._status.get(b4a.toString(connection.remotePublicKey, 'hex'))

      if (st) {
        if (st.connection) {
          st.connection.destroy(new Error('Duplicate connection'))
        }
        st.connection = connection
        if (st.timeout) {
          clearTimeout(st.timeout)
          st.timeout = null
        }
      }

      this.connections.push(connection)
      this.emit('connection', connection)

      connection.on('close', () => {
        if (st && st.connection === connection) st.connection = null
        this._removeConnection(connection)
        this._connectToSeeds()
      })
    })

    return this.server.listen(this.keyPair)
  }

  _removeConnection (connection) {
    const i = this.connections.indexOf(connection)
    if (i === -1) return
    const head = this.connections.pop()
    if (i < this.connections.length) this.connections[i] = head
  }

  _onupdate () {
    if (this.seeder) {
      // seeds should gossip with all other random seeds
      this.maxClientConnections = this.record.value.seeds.length
      this.listen().catch(safetyCatch)
    }

    this.emit('update', this.record.value)

    const latest = new Set()

    for (const s of this.seeds) {
      const k = b4a.toString(s, 'hex')
      latest.add(k)
      if (this._status.has(k)) continue

      this._pending++
      this._status.set(k, {
        tries: 0,
        publicKey: s,
        connection: this._get(s),
        timeout: null,
        removed: false,
        pending: true
      })
    }

    for (const [k, st] of this._status) {
      if (latest.has(k)) continue
      this._status.delete(k)
      if (st.connection) st.connection.destroy(new Error('Seed removed'))
      st.removed = true
      this._notPending(st)
    }

    this._connectToSeeds()
  }

  _notPending (st) {
    if (st.pending) {
      st.pending = false
      this._pending--
    }
    this._updateFlush(false)
  }

  _connectToSeeds () {
    if (this.paused || this.destroyed) return
    if (this.clientConnections >= this.maxClientConnections) return

    const pubs = this.seeds
    if (!pubs) return
    const start = Math.floor(Math.random() * pubs.length)

    for (let i = 0; i < pubs.length && this.clientConnections < this.maxClientConnections; i++) {
      const j = i + start
      const pub = pubs[j < pubs.length ? j : j - pubs.length]
      if (b4a.equals(pub, this.keyPair.publicKey)) continue

      const st = this._status.get(b4a.toString(pub, 'hex'))
      if (!st || st.timeout !== null || st.connection) continue

      this.clientConnections++
      this.clientConnecting++

      let remoteEnded = false
      let connected = false

      const conn = st.connection = this.dht.connect(pub, { keyPair: this.keyPair })

      conn.on('error', () => {})

      conn.on('connect', () => {
        connected = true
        this.clientConnecting--
        this.connections.push(conn)
        this.emit('connection', conn)
        this._notPending(st)
      })

      conn.on('end', () => {
        // graceful end, assume that means back off
        remoteEnded = true
      })

      conn.on('close', () => {
        if (st.connection === conn) st.connection = null
        if (!connected) this.clientConnecting--

        this._notPending(st)
        this._removeConnection(conn)
        this.clientConnections--

        if (this.paused) return

        const t = RETRIES[st.tries < RETRIES.length ? st.tries : RETRIES.length - 1]

        if (connected && !remoteEnded) {
          st.tries = 0
        } else {
          st.tries++
        }

        if (!st.removed) st.timeout = setTimeout(retry, Math.floor(t / 2 + Math.random() * t), this, st)
        this._connectToSeeds()
      })
    }
  }
}

function pause (swarm, drop) {
  swarm.pause({ drop })
}

function retry (swarm, st) {
  st.timeout = null
  swarm._connectToSeeds()
}
