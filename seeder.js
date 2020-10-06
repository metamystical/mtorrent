#!/usr/bin/env node

// seeder.js -- seeds torrent given metada file; announces to mdht

// Syntax: ./seeder.js metadata-file [dht-port [server-port]]
//  metadata-file -- path to torrent metadata file
//  dht-port -- port of udt mdht server (optional)
//  server-port -- local port of tcp torrent server (optional)

const fs = require('fs')
const Net = require('net')
const decode = require('./decode')
const processMeta = require('./process')
const Peer = require('./peer')
const util = require('./utilities')
const client = require('mdht/client')

const DHT_PORT = 6882 // mDHT port
const TOR_PORT = 6883 // torrent port
const MY_ID = '-MT0100-MTorrent----'  // my peer id (20 char)
const ANNOUNCE_TIMER = 300000 // reannounce after 5 minutes

let dhtPort = DHT_PORT; let torPort = TOR_PORT
const myId = Buffer.from(MY_ID); for (let i = 8; i < 20; i++) myId[i] = Math.floor(Math.random() * 256)

const argv = process.argv
if (argv.length < 3) util.report('syntax => ./seeder.js metadata-file [dht-port [server-port]]', true)
if (argv.length >= 4 && util.isPort(argv[3])) dhtPort = +argv[3]
if (argv.length === 5 && util.isPort(argv[4])) torPort = +argv[4]
util.report('DHT port (mDHT) => ' + dhtPort)
util.report('torrent port (torrent) => ' + torPort)

util.report('metadata => reading ' + argv[2])
let metadata
try {
  metadata = decode(fs.readFileSync(argv[2]))
  if (!metadata || !metadata.info || !metadata.infoHash) throw 'invalid torrent file'
} catch (err) { util.report('metadata => ' + err, true) }
util.report('metadata => infoHash: ' + metadata.infoHash.toString('hex'))
util.report('metadata => processing ' + argv[2])
try { processMeta(metadata) }
catch (err) { util.report('metadata => ' + err, true) }
if (metadata.pendingPieces.length !== 0) util.report('metadata => invalid or incomplete torrent file(s)', true)

util.report('starting server')
new Net.Server()
.listen(torPort, () => {
  util.report('listening on TCP port ' + torPort)
  announce()
})
.on('connection', (socket) => {
  const peer = new Peer(dhtPort, myId, metadata, socket)
  socket.once('end', () => { console.log('remote client ended connection') }) // triggers automatic close
  socket.once('error', (err) => { console.log('socket error: ' + err) }) // triggers automatic close
  socket.once('close', (hadErr) => {
    clearTimeout(peer.failTimer)
    delete peer
    console.log('connection closed' + (hadErr ? ' with error' : ''))
  })
  peer.start()
})
util.report('seeding ' + metadata.name.toString())

client.init(dhtPort)

function announceResults (res) {
  if (!res) util.report('DHT error', true)
  util.report('torrent announced to ' + res.numStored + ' peers')
  setTimeout(announce, ANNOUNCE_TIMER, announceResults)
}

function announce () {
  client.announcePeer(metadata.infoHash, torPort, 0, announceResults)
}
