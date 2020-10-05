const encode = require('mdht/encode')
const decode = require('./decode')

const proto = {
  maxMessage: 1E7, // 10 MB
  myMetaId: 1,
  
  getHandshake: (data, infoHash) => {
    if (
      data.length < 68 ||
      data[0] !== 19 ||
      data.slice(1, 20).toString() !== 'BitTorrent protocol' ||
      data[25] & 0x10 === 0 || // extension
      !infoHash.equals(data.slice(28, 48))
    ) return 'handshake'
    // ((this.data[27] & 0x01) !== 0) // dht
    // this.data.slice(48, 68) // peer id
    return data.slice(68)
  },
  
  sendHandshake: (infoHash, myId) => {
    return Buffer.concat([
      Buffer.from('13', 'hex'),
      Buffer.from('BitTorrent protocol'),
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x01]), // reserved bytes: ext, dht on
      infoHash, myId
    ])
  },
  
  getMessage: (data, peer) => {
    while (data.length > 0) {
      if (data.length < 4) return data // wait for more data
      const len = data.readUInt32BE(0)
      if (data.length < 4 + len) return data // wait for more data
      if (len > proto.maxMessage) { return 'message too long' }
      if (len === 0) ; // keep alive
      else {
        let id = data[4]
        if ((id < 0 || id > 9) && id != 20) { return 'invalid id' }
        switch (id) {
          case 0:
            onMessage('onChoke', true)
            break
          case 1:
            onMessage('onChoke', false)
            break
          case 2:
            onMessage('onInterested', true)
            break
          case 3:
            onMessage('onInterested', false)
            break
          case 4:
            if (len < 5) return 'have message'
            onMessage('onHavePiece', data.readUInt32BE(5))
            break
          case 5:
            onMessage('onBitfield', data.slice(5, 4 + len))
            break
          case 6:
            if (len < 13) return 'request message'
            onMessage('onRequest', { inx: data.readUInt32BE(5), begin: data.readUInt32BE(9), length: data.readUInt32BE(13) })
            break
          case 7:
            if (len < 9) return 'block message'
            onMessage('onBlock', { inx: data.readUInt32BE(5), begin: data.readUInt32BE(9), blk: data.slice(13, 4 + len) })
            break
          case 8:
            if (len < 13) return 'cancel message'
            onMessage('onCancel', { inx: data.readUInt32BE(5), begin: data.readUInt32BE(9), length: data.readUInt32BE(13) })
            break
          case 9:
            if (len < 3) return 'port message'
            onMessage('onPort', data.readUInt16BE(5))
            break
          case 20:
            const extData = data.slice(5, 4 + len)
            const ll = extData.length
            if (ll < 1) return 'extension data'
            const extId = extData[0]
            const m = decode(extData.slice(1, ll))
            if (!m) return 'extension decode'
            if (extId === 0) { // handshake
              if (!m.m.ut_metadata || m.m.ut_metadata > 255) return 'ut_metadata'
              if (!m.metadata_size) m.metadata_size = 0
              if (m.metadata_size > proto.maxMessage || m.metadata_size < 0) return 'metadata size'
              onMessage('onGetMetaHandshake', { peerMetaId: m.m.ut_metadata, metaInfoSize: m.metadata_size })
            }
            else if (extId === proto.myMetaId) {
              if (!Number.isInteger(m.piece) || m.piece < 0) return 'metadata piece'
              onMessage('onGetMetaMessage', { metaMsgType: m.msg_type, metaPiece: m.piece, metaPieceData: extData.slice(1 + encode(m).length, ll) })
            }
            break
          default:
            return 'message id'
        }
      }
      data = data.slice(4 + len)
    }
    return data
    function onMessage (cmd, args) { peer.onMessage.call(peer, cmd, args) }
  },
  
  sendChoke: (on) => {
    const buff = Buffer.alloc(5)
    buff.writeInt32BE(1, 0)
    buff[4] = on ? 0 : 1
    return buff
  },
  
  sendInterested: (am) => {
    const buff = Buffer.alloc(5)
    buff.writeInt32BE(1, 0)
    buff[4] = am ? 2 : 3
    return buff
  },

  sendHave: (inx) => {
    const buff = Buffer.alloc(9)
    buff.writeInt32BE(5, 0)
    buff[4] = 4
    buff.writeInt32BE(inx, 5)
    return buff
  },

  sendBitfield: (myBitfield) => {
    const bitfield = Buffer.alloc(5 + myBitfield.length)
    bitfield.writeInt32BE(1 + myBitfield.length, 0)
    bitfield[4] = 5
    myBitfield.copy(bitfield, 5)
    return bitfield
  },

  sendRequestBlock: (inx, begin, length) => {
    const buff = Buffer.alloc(17)
    buff.writeInt32BE(13, 0)
    buff[4] = 6
    buff.writeInt32BE(inx, 5)
    buff.writeInt32BE(begin, 9)
    buff.writeInt32BE(length, 13)
    return buff
  },

  sendBlock: (inx, begin, blk) => {
    const buff = Buffer.alloc(13 + blk.length)
    buff.writeInt32BE(9 + blk.length, 0)
    buff[4] = 7
    buff.writeInt32BE(inx, 5)
    buff.writeInt32BE(begin, 9)
    blk.copy(buff, 13)
    return buff
  },

  sendCancel: (inx, begin, length) => {
    const buff = Buffer.alloc(17)
    buff.writeInt32BE(13, 0)
    buff[4] = 8
    buff.writeInt32BE(inx, 5)
    buff.writeInt32BE(begin, 9)
    buff.writeInt32BE(length, 13)
    return buff
  },
  
  sendPort: (port) => {
    const buff = Buffer.alloc(7)
    buff.writeInt32BE(3, 0)
    buff[4] = 9
    buff.writeInt16BE(port, 5)
    return buff
  },

  sendMetaHandshake: (metaInfoSize) => {
    return proto.extMessage(0, { m: { ut_metadata: proto.myMetaId }, metadata_size: metaInfoSize })
  },

  sendMetaRequest: (peerMetaId, metaPiece) => {
    return proto.extMessage(peerMetaId, { msg_type: 0, piece: metaPiece })
  },

  sendMetaData: (peerMetaId, metaPiece, metaInfoSize, metaData) => {
    return proto.extMessage(peerMetaId, { msg_type: 1, piece: metaPiece, total_size: metaInfoSize }, metaData)
  },

  sendMetaReject: (peerMetaId, metaPiece) => {
    return proto.extMessage(peerMetaId, { msg_type: 2, piece: metaPiece })
  },
  
  extMessage: (id, mess, data) => {
    if (!data) data = Buffer.alloc(0) 
    mess = encode(mess)
    let buff = Buffer.alloc(mess.length + 6)
    buff.writeInt32BE(data.length + mess.length + 2, 0)
    buff[4] = 20
    buff[5] = id
    mess.copy(buff, 6)
    buff = Buffer.concat([buff, data])
    return buff
  }
}

module.exports = proto
