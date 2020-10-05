module.exports = {
  isHex: (str, len) => { return (len ? str.length === len : true) && /^[0-9a-fA-F]+$/.test(str) },

  isPort: (port) => { return port > 1023 && port < 65536 },
  
  getPieceLength: (spot) => { return spot.reduce((a, spot) => { return(a + spot.length) }, 0) },

  setBitfield: (bits, inx) => {
    const byte = Math.floor(inx / 8)
    const bit = 128 >>> (inx - byte * 8)
    bits[byte] |= bit
  },

  isSetBitfield: (bits, inx) => {
    if (!bits) return false
    const byte = Math.floor(inx / 8)
    const bit = 128 >>> (inx - byte * 8)
    return (bits[byte] & bit) !== 0
  },

  makeLoc: (address, port) => { // converts 'address, port' to 6-byte hex buffer, where address is an IPv4 address
    const arr = []
    address.split('.').forEach((dec) => { arr.push(parseInt(dec, 10)) })
    arr.push(port >>> 8, port & 0xff)
    return Buffer.from(arr)
  },

  unmakeLoc: (loc) => { // convert 6-byte buffer to IPv4 address/port
    let str = ''
    for (let i = 0; i < 4; i++) str += loc[i] + (i < 3 ? '.' : '')
    return { address: str, port: buffToInt(loc.slice(4)) }
    function buffToInt (buff) { return (buff[0] << 8) + buff[1] }
  },

  report: (mess, err) => {
    if (err) mess = 'error: ' + mess
    console.log('%s: %s', timeStr(Date.now()), mess)
    if (err) process.exit(1)
    function timeStr (time) {
      const date = (new Date(time)).toJSON()
      return date.slice(0, 10) + ' ' + date.slice(11, 19) + ' UTC'
    }
  }
}
