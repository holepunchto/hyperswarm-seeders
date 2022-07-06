const c = require('compact-encoding')

const seeds = c.array(c.fixed32)

const core = {
  preencode (state, m) {
    c.uint.preencode(state, m.length)
    c.uint.preencode(state, m.fork)
  },
  encode (state, m) {
    c.uint.encode(state, m.length)
    c.uint.encode(state, m.fork)
  },
  decode (state) {
    return {
      length: c.uint.decode(state),
      fork: c.uint.decode(state)
    }
  }
}

exports.record = {
  preencode (state, m) {
    state.end += 2 // version + flags
    seeds.preencode(state, m.seeds)
    if (m.core) core.preencode(state, m.core)
  },
  encode (state, m) {
    state.buffer[state.start++] = 0
    state.buffer[state.start++] = m.core ? 1 : 0
    seeds.encode(state, m.seeds)
    if (m.core) core.encode(state, m.core)
  },
  decode (state) {
    const v = c.uint.decode(state)
    if (v !== 0) throw new Error('Unknown version: ' + v)
    const flags = c.uint.decode(state)
    return {
      seeds: seeds.decode(state),
      core: (flags & 1) !== 0 ? core.decode(state) : null
    }
  }
}
