'use strict'

const { createServer } = require('net')
const EventEmitter = require('events')
const debug = require('debug')('socket.io-monitor')
const protocol = require('./protocol')


/**
 * Options:
 * - server: boolean = true (start server ? Otherwise just expose the emitter)
 * - port: number = 9042
 * - host: string = 'localhost'
 * - password: string? = null (server password)
 *
 * Output:
 * - emitter: EventEmitter
 * - server: Promise<net.Server>
 */
module.exports = (io, options = {}) => {
  const { server = true } = options

  const emitter = initEmitter(io, options)

  return server
    ? { emitter, server: initServer(emitter, options) }
    : { emitter, server: null }
}


const initServer = exports.initServer = (emitter, options = {}) => new Promise((resolve, reject) => {
  const { port = 9042, host = 'localhost' } = options

  const server = createServer()

  server.listen(port, host)

  server.once('listening', () => {
    resolve(server)
    server.on('connection', connHandler(emitter, options))
  })

  server.once('error', err => reject(err))
})


const monkeyPatch = (object, method, fn) => {
  const orig = object[method]
  object[method] = function (...args) {
    fn.apply(this, args)
    return orig.apply(this, args)
  }
}


const initEmitter = exports.initEmitter = (io, options = {}) => {
  const e = new EventEmitter();

  const adapter = io.sockets.adapter

  // Monitor broadcasts
  monkeyPatch(adapter, 'broadcast', (packet, { rooms = [], flags = {} }) => {
    if (packet.type === 2) {
      const [ name, ...args ] = packet.data
      const flagsList = Object.keys(flags).filter(f => flags[f])
      e.emit('broadcast', { name, args, rooms, flags: flagsList })
    }
  })

  // Monitor rooms
  monkeyPatch(adapter, 'add', (id, room) => {
    if (id !== room) {
      e.emit('join', { id, room })
    }
  })
  monkeyPatch(adapter, 'del', (id, room) => {
    e.emit('leave', { id, room })
  })
  monkeyPatch(adapter, 'delAll', id => {
    e.emit('leaveAll', { id })
  })

  // Monitor connections
  io.on('connection', ws => {
    e.emit('connect', { id: ws.id })

    // Monitor disconnections
    ws.on('disconnect', () => e.emit('disconnect', { id: ws.id }))

    // Monitor messages client → server
    monkeyPatch(ws, 'emit', (name, ...args) => {
      if (typeof args[args.length - 1] === 'function') {
        args.pop()
      }
      e.emit('emit', { id: ws.id, name, args })
    })

    // Monitor messages server → client
    monkeyPatch(ws, 'dispatch', ([ name, ...args ]) => {
      if (typeof args[args.length - 1] === 'function') {
        args.pop()
      }
      e.emit('recv', { id: ws.id, name, args })
    })
  })

  e.getState = () => getState(io)

  // Debug (oh look, a synthetic list of all events you could use as documentation)
  if (debug.enabled) {
    e
    .on('string', ({ id, string }) => debug('string', id, string))
    .on('broadcast', ({ name, args, rooms, flags }) => debug('broadcast', name, args, rooms, flags))
    .on('join', ({ id, room }) => debug('join', id, room))
    .on('leave', ({ id, room }) => debug('leave', id, room))
    .on('leaveAll', ({ id }) => debug('leaveAll', id))
    .on('connect', ({ id }) => debug('connect', id))
    .on('disconnect', ({ id }) => debug('disconnect', id))
    .on('emit', ({ id, name, args }) => debug('emit', id, name))
    .on('recv', ({ id, name, args }) => debug('recv', id, name))
  }

  return e
}

const noop = () => {}

const connHandler = (emitter, options) => {
  const { password = null, authTimeout = 1500, onError = noop } = options

  // Store list of all bound protocols, avoids memory leak by binding too many handlers
  let protos = []
  const addProto = proto => {
    protos = protos.concat([ proto ])
    setImmediate(() => {
      emitter.getState()
      .then(data => {
        emitter.emit('client', { client: proto, state: data })
        proto.emit('init', data)
      })
      .catch(err => proto.emit('error', err.message))
    })
  }
  const removeProto = proto => {
    protos = protos.filter(p => p !== proto)
    proto.removeAllListeners()
  }
  const dispatch = name => data => {
    protos.forEach(proto => proto.emit(name, data))
  }

  // Retransmit events
  emitter
  .on('string', dispatch('string'))
  .on('broadcast', dispatch('broadcast'))
  .on('join', dispatch('join'))
  .on('leave', dispatch('leave'))
  .on('leaveAll', dispatch('leaveAll'))
  .on('connect', dispatch('connect'))
  .on('disconnect', dispatch('disconnect'))
  .on('emit', dispatch('emit'))
  .on('recv', dispatch('recv'))

  return socket => {
    socket.on('error', err => debug('socket error', err))
    socket.on('error', noop)

    const proto = protocol.bindSocket(socket)

    socket.on('close', () => removeProto(proto))

    let authorized = false

    // Plug TCP socket to local emitter
    const init = () => {
      authorized = true
      addProto(proto)
    }

    // Authentication
    let timeout = null
    if (!password) {
      proto.emit('reqAuth', false)
      // Wait for an empty password though, to ensure roundtrip is complete
      proto.once('password', () => init())
    } else {
      proto.emit('reqAuth', true)
      // Auth timeout
      const timeout = setTimeout(() => {
        proto.emit('auth', { authorized: false, error: 'TIMEOUT' })
        socket.end()
      }, authTimeout)
      proto.once('password', pwd => {
        clearTimeout(timeout)
        if (pwd === password) {
          proto.emit('auth', { authorized: true })
          init()
        } else {
          proto.emit('auth', { authorized: false, error: 'INVALID_PASSWORD' })
          socket.end()
        }
      })
    }
  }
}


// Grab rooms & sockets data
const getState = io => Promise.resolve().then(() => {
  // Aggregate data from rooms
  const forEachRoom = (fn, initial) => Object.keys(io.sockets.adapter.rooms).reduce((data, name) => {
    const info = io.sockets.adapter.rooms[name]
    return fn(data, info, name)
  }, initial)

  // rooms: Array<{ name: string, sockets: Array<string> }>
  const rooms = forEachRoom((rooms, info, name) => {
    if (info.length === 1 && info.sockets[name]) {
      // A personal room, juste skip it
      return rooms
    }
    rooms.push({
      name,
      sockets: Object.keys(info.sockets).filter(id => info.sockets[id])
    })
    return rooms
  }, [])

  // sockets: Array<string>
  const sockets = Object.keys(forEachRoom((dict, info, name) => {
    Object.keys(info.sockets).forEach(id => {
      if (info.sockets[id]) {
        dict[id] = true
      }
    })
    return dict
  }, {}))

  return { rooms, sockets }
})
