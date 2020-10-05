module.exports = Peer

const fs = require('fs')
const tcp = require('net')
const crypto = require('crypto')
const util = require('./utilities')
const proto = require('./protocol')

const BLOCK_TIMER = 60000 // maximum block delay (ms) to avoid abort
const HANDSHAKE_TIMER = 5000 // maximum handshake delay (ms) to avoid abort
const RETRY_TIMER = 1000 // delay to retry
const MAX_BLOCK_SIZE = 16384
const META_PIECE_SIZE = 16384
const BLOCK_PIPELINE = 5

function Peer (torrent, peer) {
  this.torrent = torrent
  this.peer = peer
  this.peerBitfield; this.piece; this.numBlocks
  this.blocks; this.nextBlock; this.pieceData; this.failTimer
  this.shook = false; this.peerChoked = true; this.peerInterested = false
  this.c
  this.data = Buffer.alloc(0)
  this.shook = false
  this.peerMetaId; this.metaPiece = 0; this.metainfo = []
  this.metaInfoSize = torrent.decodedMetadata ? torrent.decodedMetadata.infoRaw.length : 0
}

Peer.prototype.socket = function (c, seeder) {
  this.c = c
  c.once('error', (err) => { console.log('socket error: ' + err) }) // triggers automatic close
  c.once('close', (hadErr) => {
    console.log('connection closed' + (hadErr ? ' with error' : ''))
    this.torrent.onFinish.call(this.torrent, this.peer)
  })
  c.on('data', (chunk) => {
    this.data = Buffer.concat([this.data, chunk], this.data.length + chunk.length)
    if(!this.shook) {
      this.data = proto.getHandshake(this.data, this.torrent.infoHash)
      if(!Buffer.isBuffer(this.data)) { this.abort(this.data); return }
      clearTimeout(this.failTimer)
      this.shook = true
      this.write(proto.sendMetaHandshake(this.metaInfoSize))
      this.failTimer = setTimeout(this.abort.bind(this), BLOCK_TIMER, 'block timeout')
      if (this.torrent.name) this.write(proto.sendBitfield(this.torrent.myBitfield))
      this.write(proto.sendPort(this.localPort))
      this.write(proto.sendChoke(false))
      if (this.torrent.pendingPieces.length > 0) {
        this.write(proto.sendInterested(true))
        this.startDownloadIfReady()
      }
    }
    this.data = proto.getMessage(this.data, this)
    if(!Buffer.isBuffer(this.data)) this.abort(this.data)
  })
  if (!seeder) {
    this.failTimer = setTimeout(this.abort.bind(this), HANDSHAKE_TIMER, 'handshake timeout')
    this.write(proto.sendHandshake(this.torrent.infoHash, this.torrent.myId))
  }
}

Peer.prototype.abort = function (reason) {
  this.ungetPiece()
  clearTimeout(this.failTimer)
  this.c.destroy()
  if (reason) console.log('peer error: ' + reason) // debug
}

Peer.prototype.write = function (b) { if (!this.c.destroyed) this.c.write(b) }

Peer.prototype.startDownloadIfReady = function () {
  // torrent must have valid_metadata and peer must have sent its bitfield and unchoke
  if (this.shook && this.peerBitfield && this.torrent.name && !this.peerChoked) this.getPiece()
  else { if (!this.c.destroyed) setTimeout(this.startDownloadIfReady.bind(this), RETRY_TIMER) }
}

Peer.prototype.getPiece = function () {
  this.piece = null
  if (this.torrent.pendingPieces.length === 0) { this.abort(''); return }
  let i = 0
  while (i < this.torrent.pendingPieces.length) {
    if (util.isSetBitfield(this.peerBitfield, this.torrent.pendingPieces[i].index)) break
    ++i
  }
  if (i === this.torrent.pendingPieces.length) { this.abort(''); return }
  this.piece = this.torrent.pendingPieces.splice(i, 1)[0]
  this.blocks = 0; this.nextBlock = 0
  this.pieceData = Buffer.alloc(util.getPieceLength(this.piece.spot))
  this.numBlocks = Math.ceil(this.pieceData.length / MAX_BLOCK_SIZE)
  this.requestBlocks()
}

Peer.prototype.ungetPiece = function () {
  this.piece && this.torrent.pendingPieces.unshift(this.piece)
  this.piece = null
}

Peer.prototype.requestBlocks = function () {
  if (!this.piece) return
  const maxBlock = Math.min(this.blocks + BLOCK_PIPELINE, this.numBlocks)
  while (this.nextBlock < maxBlock) {
    const blockSize = (this.nextBlock === this.numBlocks - 1) ? this.pieceData.length - this.nextBlock * MAX_BLOCK_SIZE : MAX_BLOCK_SIZE
    if (!this.peerChoked) this.write(proto.sendRequestBlock(this.piece.index, this.nextBlock * MAX_BLOCK_SIZE, blockSize))
    ++this.nextBlock
  }
}

Peer.prototype.sendHave = function (index) {
  if (!this.shook || this.peerChoked) { if (!this.c.destroyed) setTimeout(this.sendHave.bind(this), RETRY_TIMER, index); return }
  this.write(proto.sendHave(index))
}

Peer.prototype.onMessage = function (cmd, args) {
  switch(cmd) {
    case 'onChoke':
      this.peerChoked = args
      if (args) this.ungetPiece()
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
      const piece = this.torrent.pieces[args.inx]
      const pieceData = Buffer.alloc(util.getPieceLength(piece.spot))
      piece.spot.forEach((spot) => { fs.readSync(spot.fd, pieceData, spot.pStart, spot.length, spot.fStart) })
      this.write(proto.sendBlock(args.inx, args.begin, pieceData.slice(args.begin, args.begin + args.length)))
      break
    case 'onBlock':
      if (!this.piece || args.inx !== this.piece.index) return
      this.failTimer.refresh()
      const block = Math.floor(args.begin / MAX_BLOCK_SIZE)
      args.blk.copy(this.pieceData, block * MAX_BLOCK_SIZE)
      if (++this.blocks === this.numBlocks) {
        if (!crypto.createHash('sha1').update(this.pieceData).digest().equals(this.piece.sha)) { this.abort('sha mismatch'); return }
        this.torrent.onPiece.call(this.torrent, this.piece.index)
        this.piece.spot.forEach((spot) => { fs.writeSync(spot.fd, this.pieceData, spot.pStart, spot.length, spot.fStart) })
        setImmediate(this.startDownloadIfReady.bind(this))
      }
      else setImmediate(this.requestBlocks.bind(this))
      break
    case 'onCancel':
      this.abort('invalid cancel') // no unchoke sent
      break
    case 'onPort':
      break
    case 'onGetMetaHandshake':
      this.peerMetaId = args.peerMetaId
      if (!this.torrent.name && (this.metaInfoSize = args.metaInfoSize)) this.write(proto.sendMetaRequest(this.peerMetaId, this.metaPiece))
      break
    case 'onGetMetaMessage':
      if (args.metaMsgType === 0) { // request
        if (!this.torrent.name || this.metaPiece > Math.ceil(this.metaInfoSize / META_PIECE_SIZE)) this.abort('metadata request')
        const start = this.metaPiece * META_PIECE_SIZE
        let end = start + META_PIECE_SIZE
        if (end > this.metaInfoSize) end = this.metaInfoSize
        const data = this.torrent.decodedMetadata.infoRaw.slice(start, end)
        this.write(proto.sendMetaData(this.peerMetaId, this.metaPiece++, this.metaInfoSize, data))
      }
      else if (args.metaMsgType === 1) { // incoming data
        if (args.metaPiece !== this.metaPiece) this.abort('metadata data')
        this.metainfo.push(args.metaPieceData)
        if (++this.metaPiece === Math.ceil(this.metaInfoSize / META_PIECE_SIZE)) {
          this.metainfo = Buffer.concat(this.metainfo)
          const sha1 = Buffer.from(crypto.createHash('sha1').update(this.metainfo).digest())
          if (sha1.equals(this.torrent.infoHash)) this.torrent.onMetainfo.call(this.torrent, this.metainfo)
          else this.abort('metadata sha1')
        }
        else this.write(proto.sendMetaRequest(this.peerMetaId, this.metaPiece))
      }
      else if (args.metaMsgType === 2) { this.abort('metadata reject') } // reject
      else this.abort('metadata message type')
      break
    default:
      this.abort('bad event')
  }
}
