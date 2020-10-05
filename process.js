const fs = require('fs')
const util = require('./utilities')
const crypto = require('crypto')

module.exports = function (metadata, truncate) { // truncate torrent files if they already exist
  const ret = {}
  const info = metadata.info
  ret.name = info['name']; let files = info['files']; let length = info['length']
  const pieces = info['pieces']; const pieceLength = info['piece length']
  if (!ret.name || !pieces || !pieceLength || !length === !files) throw 'invalid metadata'
  const nameExists = fs.existsSync(Buffer.from(ret.name))
  const numPieces = pieces.length / 20
  ret.myBitfield = Buffer.alloc(Math.ceil(numPieces / 8)).fill(0)
  ret.pendingPieces = []

  try { createDirectories() } catch (err) { throw 'failed to create torrent directories' }
  if (Math.ceil(length / pieceLength) !== numPieces) throw 'pieces mismatch'
  try { mapPieces() } catch (err) { throw 'failed to open torrent files' }
  try { checkPieces() } catch (err) { throw 'failed to read torrent files' }

  return (ret)

  function createDirectories () { // redefines global variables 'length' and 'files'
    if (length) files = [{ length: length, path: ret.name }] // single file
    else { // condense path array into single buffer and create directory tree
      length = 0
      const unique = []
      const slash = Buffer.from('/')
      files.forEach((file) => {
        length += file.length
        let path = [Buffer.from(ret.name), slash] // root directory
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

  function mapPieces () { // map pieces to files, opens files
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
    ret.pieces = pcs
  }

  function checkPieces () { // check for previously downloaded pieces, set pendingPieces and myBitfield
    ret.pieces.forEach((piece, index) => {
      if (truncate || !nameExists) { ret.pendingPieces.push(index); return }
      const pieceData = Buffer.alloc(util.getPieceLength(piece.spot))
      piece.spot.forEach((spot) => { fs.readSync(spot.fd, pieceData, spot.pStart, spot.length, spot.fStart) })
      if (crypto.createHash('sha1').update(pieceData).digest().equals(piece.sha)) util.setBitfield(ret.myBitfield, piece.index)
      else ret.pendingPieces.push(index)
    })
  }
}
