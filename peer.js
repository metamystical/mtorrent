module.exports = Peer

const fs = require('fs')
const util = require('./utilities')
const proto = require('./protocol')

const BLOCK_TIMER = 60000 // maximum block delay (ms) to avoid abort
const META_PIECE_SIZE = 16384

function Peer (dhtPort, myId, meta, socket) {
  this.dhtPort = dhtPort
  this.myId = myId
  this.name = meta.name
  this.myBitfield = meta.myBitfield
  this.pieces = meta.pieces
  this.infoHash = meta.infoHash
  this.infoRaw = meta.infoRaw
  this.socket = socket
  this.shook = false
  this.data = Buffer.alloc(0)
  this.peerBitfield
  this.peerChoked = true
  this.peerInterested = false
  this.peerMetaId; this.metaPiece = 0
  this.failTimer
}

Peer.prototype.start = function () {
  this.socket.on('data', (chunk) => {
    this.data = Buffer.concat([this.data, chunk], this.data.length + chunk.length)
    if(!this.shook) {
      this.data = proto.getHandshake(this.data, this.infoHash)
      if(!Buffer.isBuffer(this.data)) { this.abort(this.data); return }
      this.shook = true
      this.write(proto.sendHandshake(this.infoHash, this.myId))
      this.write(proto.sendMetaHandshake(this.infoRaw.length))
    }
    this.data = proto.getMessage(this.data, this)
    if(!Buffer.isBuffer(this.data)) this.abort(this.data)
  })
}

Peer.prototype.abort = function (reason) {
  this.socket.destroy()
  if (reason) console.log('peer error: ' + reason) // debug
}

Peer.prototype.write = function (b) { if (!this.socket.destroyed) this.socket.write(b) }

Peer.prototype.onMessage = function (cmd, args) {
  switch(cmd) {
    case 'onChoke':
      this.peerChoked = args
      break
    case 'onInterested':
      this.peerInterested = args
      break
    case 'onHavePiece':
      if (this.peerBitfield) util.setBitfield(this.peerBitfield, args)
      break
    case 'onBitfield':
      this.peerBitfield = args
      break
    case 'onRequest':
     this.failTimer.refresh()
      const piece = this.pieces[args.inx]
      const pieceData = Buffer.alloc(util.getPieceLength(piece.spot))
      piece.spot.forEach((spot) => { fs.readSync(spot.fd, pieceData, spot.pStart, spot.length, spot.fStart) })
      this.write(proto.sendBlock(args.inx, args.begin, pieceData.slice(args.begin, args.begin + args.length)))
      break
    case 'onBlock':
      break
    case 'onCancel':
      break
    case 'onPort':
      break
    case 'onGetMetaHandshake':
      this.peerMetaId = args.peerMetaId
      break
    case 'onGetMetaMessage':
      if (args.metaMsgType === 0) { // request
        if (this.metaPiece !== args.metaPiece) this.abort('metadata request')
        const start = this.metaPiece * META_PIECE_SIZE
        let end = start + META_PIECE_SIZE
        const len =  this.infoRaw.length
        if (end > len) end = len
        this.write(proto.sendMetaData(this.peerMetaId, this.metaPiece++, len, this.infoRaw.slice(start, end)))
        if (this.metaPiece === Math.ceil(len / META_PIECE_SIZE)) {
          this.write(proto.sendBitfield(this.myBitfield))
          this.write(proto.sendPort(this.dhtPort))
          this.write(proto.sendChoke(false))
          this.failTimer = setTimeout(this.abort.bind(this), BLOCK_TIMER, 'block timeout')
        }
      }
      else if (args.metaMsgType === 1) { // incoming data
      }
      else if (args.metaMsgType === 2) { this.abort('metadata reject') } // reject
      else this.abort('metadata message type')
      break
    default:
      this.abort('bad event')
  }
}
