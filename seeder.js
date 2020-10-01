#!/usr/bin/env node

const fs = require('fs')
const util = require('./utilities')
const decode = require('./decode')
const Torrent = require('./torrent')

const PORT = 6882 // same DHT and torrent port

let port = PORT
const argv = process.argv
if (argv.length < 3) util.report('syntax: ./leecher.js metadata-file | info-hash [server-port]', true)
if (argv.length === 4 && argv[3] > 1023 && argv[3] < 65536) port = argv[3]

let infoHash; let decodedMetadata
if (util.isHex(argv[2], 40)) infoHash = Buffer.from(argv[2], 'hex')
else {
  try {
    decodedMetadata = decode(fs.readFileSync(argv[2]))
    if (!decodedMetadata.info || !decodedMetadata.infoHash) throw ''
  } catch (err) { console.log(err); util.report('invalid metadata file => ' + argv[2], true) }
  infoHash = decodedMetadata.infoHash
}
util.report('infoHash => ' + infoHash.toString('hex'))
new Torrent(infoHash, [ util.makeLoc('127.0.0.1', 6881) ], decodedMetadata, port).start()
