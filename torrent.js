module.exports = Torrent

const fs = require('fs')
const tcp = require('net')
const crypto = require('crypto')
const util = require('./utilities')
const decode = require('./decode')
const Peer = require('./peer')

const MAX_CONCURRENT_PEERS = 50
const MY_ID = '-MT0100-MTorrent----'  // my peer id (20 char)

function Torrent (infoHash, peerPool, decodedMetadata, localPort) {
  this.infoHash = infoHash
  this.peerPool = peerPool
  this.decodedMetadata = decodedMetadata
  this.localPort = localPort
  this.name // if defined, metadata considered valid
  this.numPieces
  this.pendingPieces = []
  this.myBitfield
  this.myId = Buffer.from(MY_ID); for (let i = 8; i < 20; i++) this.myId[i] = Math.floor(Math.random() * 256)
  this.activePeers = {}
}

Torrent.prototype.start = function () {
  if (this.decodedMetadata) this.processMetadata()
  if (this.pendingPieces.length > 0) { // leecher
    let desiredNumPeers = Math.min(MAX_CONCURRENT_PEERS, this.peerPool.length)
    while (desiredNumPeers-- > 0) this.addPeer()
  }
  else { // seeder
    const server = new tcp.Server()
    server.listen(this.localPort, () => { util.report('listening on port ' + this.localPort) })
    server.on('connection', (socket) => { this.addPeer(socket) })
  }
}

Torrent.prototype.abort = function (reason) { util.report(reason, true) }

Torrent.prototype.addPeer = function (socket) {
  let peer
  if (socket) {
    let addr = socket.remoteAddress
    if (addr.slice(0, 7) === '::ffff:') addr = addr.slice(7)
    else if(socket.remoteFamily == 'IPv6') util.report('peer has IPv6', true)
    peer = util.makeLoc(addr, socket.remotePort)
  }
  else peer = this.peerPool.shift()
  if (!peer) return
  const pr = peer.toString('hex')
  if (this.activePeers[pr] !== undefined) return
  this.activePeers[pr] = new Peer(this, peer, this.localPort)
  this.activePeers[pr].socket(socket)
}

Torrent.prototype.onPiece = function (inx) {
  util.setBitfield(this.myBitfield, inx)
  Object.values(this.activePeers).forEach((peer) => { peer.sendHave(inx) })
  util.report('downloaded piece ' + (inx + 1) + ' of ' + this.numPieces + ', ' + Object.keys(this.activePeers).length + ' peers')
}

Torrent.prototype.onFinish = function (peer) {
  const pr = peer.toString('hex')
  delete this.activePeers[pr]
  if (this.pendingPieces.length && this.peerPool.length) setImmediate(this.addPeer.bind(this))
  else if (!Object.keys(this.activePeers).length) {
    util.report('total downloaded => ' + Math.floor(100 * (1 - this.pendingPieces.length / this.numPieces)) + '%')
  }
}

Torrent.prototype.onMetainfo = function (infoRaw) {
  if (this.name) return
  const metadata = Buffer.concat([Buffer.from('d4:info'), infoRaw, Buffer.from('e')])
  let path; let decodedMetadata
  try {
    if (!(decodedMetadata = decode(metadata))) throw ''
    path = decodedMetadata.info.name.toString() + '.torrent'
  } catch (err) { this.abort('invalid metadata') }
  fs.writeFile(path, metadata, (err) => { if (err) this.abort('writing to torrent file') })
  decodedMetadata.infoRaw = infoRaw
  decodedMetadata.infoHash = this.infoHash
  this.decodedMetadata = decodedMetadata
  this.processMetadata(true)
}

Torrent.prototype.processMetadata = function (truncate) { // truncate == restart download
  util.report('processing metadata')
  const info = this.decodedMetadata.info
  this.name = info['name']; let files = info['files']; let length = info['length']
  let pieces = info['pieces']; const pieceLength = info['piece length']
  if (!this.name || !pieces || !pieceLength || !length === !files) this.abort('invalid metadata')
  const nameExists = fs.existsSync(Buffer.from(this.name))
  this.numPieces = pieces.length / 20
  this.myBitfield = Buffer.alloc(Math.ceil(this.numPieces / 8)).fill(0)

  try { createDirectories.call(this) } catch (err) { this.abort('failed to create torrent directories') }
  if (Math.ceil(length / pieceLength) !== this.numPieces) this.abort('pieces mismatch')
  try { mapPieces.call(this) } catch (err) { this.abort('failed to open torrent files') }
  try { checkPieces.call(this) } catch (err) { this.abort('failed to read torrent files') }

  const valid = this.numPieces - this.pendingPieces.length
  util.report('previously downloaded => ' + Math.floor(100 * valid / this.numPieces) + '%')
  if (valid === this.numPieces) util.report('seeding => ' + this.name.toString())
  else util.report('downloading => ' + this.name.toString())

  function createDirectories () { // redefines global variables 'length' and 'files'
    if (length) files = [{ length: length, path: this.name }] // single file
    else { // condense path array into single buffer and create directory tree
      length = 0
      const unique = []
      const slash = Buffer.from('/')
      files.forEach((file) => {
        length += file.length
        let path = [Buffer.from(this.name), slash] // root directory
        const filename = file.path.pop()
        while (file.path.length > 0) path.push(file.path.shift(), slash)
        path = Buffer.concat(path)
        let i = 0
        for (; i < unique.length; i++) { if (unique[i].equals(path)) break }
        if (i === unique.length) { unique.push(path); fs.mkdirSync(path, { recursive: true }) }
        file.path = Buffer.concat([path, filename])
      })
      // length is now total length of all files
    }
  }

  function mapPieces () { // map pieces to files, opens files, redefines global variable 'pieces'
    const pcs = []
    let pStart = pieceLength
    let pinx = -1
    files.forEach((file) => {
      fs.closeSync(fs.openSync(file.path, 'a')) // create if necessary, don't truncate if exists
      if (truncate) fs.truncateSync(file.path)
      const fd = fs.openSync(file.path, 'r+')
      let fStart = 0
      const fEnd = file.length
      while (fEnd > fStart) {
        if (pStart === pieceLength) {
          pStart = 0
          const inx = ++pinx * 20
          pcs.push({ index: pinx, sha: pieces.slice(inx, inx + 20), spot: [] })
        }
        const needed = fEnd - fStart
        const available = pieceLength - pStart
        const writeLength = needed >= available ? available : needed
        pcs[pinx].spot.push({ fd: fd, fStart: fStart, pStart: pStart, length: writeLength })
        fStart += writeLength
        pStart += writeLength
      }
    })
    pieces = pcs
  }

  function checkPieces () { // check for previously downloaded pieces, set pendingPieces and myBitfield
    pieces.forEach((piece) => {
      if (truncate || !nameExists) { this.pendingPieces.push(piece); return }
      const pieceData = Buffer.alloc(util.getPieceLength(piece.spot))
      piece.spot.forEach((spot) => { fs.readSync(spot.fd, pieceData, spot.pStart, spot.length, spot.fStart) })
      if (crypto.createHash('sha1').update(pieceData).digest().equals(piece.sha)) util.setBitfield(this.myBitfield, piece.index)
      else this.pendingPieces.push(piece)
    })
  }
}

// todo: eliminate pieces.index; pending pieces is just array of indexes
