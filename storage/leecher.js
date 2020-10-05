#!/usr/bin/env node

// leecher.js -- downloads torrent given metada file or infoHash; gets peers from mdht

// Syntax: ./leecher.js metadata-file | info-hash [server-port]
//  metadata-file | info-hash -- path to torrent metadata file | 40 hex digit torrent info-hash
//  server-port -- port of dht server (optional, default port)

const fs = require('fs')
const dns = require('dns')
const dhtInit = require('mdht')
const util = require('./utilities')
const decode = require('./decode')
const Torrent = require('./torrent')

const DHT_BOOT_FILE = '.boot' // stores previously found boot locations
const BACKUP_DHT_BOOT_LOC = 'router.bittorrent.com:6881' // alternate router.utorrent.com:6881
const PORT = 6882 // same DHT and torrent port

const argv = process.argv
if (argv.length < 3) util.report('syntax: ./leecher.js metadata-file | info-hash [server-port]', true)

let port = PORT
if (argv.length === 4 && argv[3] > 1023 && argv[3] < 65536) port = argv[3]

let infoHash; let decodedMetadata
if (util.isHex(argv[2], 40)) infoHash = Buffer.from(argv[2], 'hex')
else {
  try {
    decodedMetadata = decode(fs.readFileSync(argv[2]))
    if (!decodedMetadata.info || !decodedMetadata.infoHash) throw ''
  } catch (err) { util.report('invalid metadata file => ' + argv[2], true) }
  infoHash = decodedMetadata.infoHash
}
util.report('infoHash => ' + infoHash.toString('hex'))

util.report('DHT boot from => ' + DHT_BOOT_FILE)
let bootLocs
try { bootLocs = fs.readFileSync(DHT_BOOT_FILE) }
catch (err) { }
if (bootLocs) getPeers()
else {
  util.report('backup DHT boot from => ' + BACKUP_DHT_BOOT_LOC)
  const parts = BACKUP_DHT_BOOT_LOC.split(':')
  if (parts.length !== 2 || !(parts[1] > 0 && parts[1] < 65536)) report('invalid address:port => ' + BACKUP_DHT_BOOT_LOC, true)
  else dns.lookup(parts[0], { family: 4 }, (err, address) => {
    if (err) report('DNS lookup error => ' + parts[0], true)
    bootLocs = util.makeLoc(address, parts[1])
    getPeers()
  })
}

function getPeers () {
  util.report('starting DHT on port => ' + port)
  const dht = dhtInit({ port: port, bootLocs: bootLocs }, (key, value) => {
    if (key == 'ready') {
      util.report('DHT started => ' + value + ' nodes visited')
      dht.getPeers(infoHash, (res) => {
        dht.stop()
        if (!res || !res.peers || !res.numFound) util.report('no peers found', true)
        const peerPool = res.peers.filter((peer) => { return util.unmakeLoc(peer).port >= 1000 })
        util.report('peers found => ' + peerPool.length)
        new Torrent(infoHash, peerPool, decodedMetadata, port).start()
      })
    }
    else if (key == 'nodes') {
      try { fs.writeFileSync(DHT_BOOT_FILE, value) } catch (err) { }
    }
  })
}
