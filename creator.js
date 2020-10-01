#!/usr/bin/env node

// creator.js -- creates a torrent file in the current directory given a path to a file or directory

const crypto = require('crypto')
const fs = require('fs')
const pt = require('path')
const encode = require('mdht/encode')

const PIECE_LENGTH = 1048576 // 1 M

const argv = process.argv
if (argv.length < 3) report('syntax => ./creator.js path-to-file-or-directory', true)

create(argv[2], (obj) => {
  report('info hash => ' + obj.ih)
  saveData(obj.name + '.torrent', obj.torrFile)
})

function getFileInfo (path) { try { return fs.statSync(path) } catch (err) { return null } }

function getFiles(path) { try { return fs.readdirSync(path) } catch (err) { return null } }

function sha1 (buff) { return crypto.createHash('sha1').update(buff).digest() }

function report (mess, err) {
  console.log('%s: %s', timeStr(Date.now()), mess)
  if (err) process.exit(1)
}

function timeStr (time) {
  const date = (new Date(time)).toJSON()
  return date.slice(0, 10) + ' ' + date.slice(11, 19) + ' UTC'
}

function saveData (path, data) { // data is buffer or utf-8 string
  try { fs.writeFileSync(path, data) } catch (err) {
    if (err) report('error writing to => ' + path, true)
  }
}

function create(path, next) {
  const prefix = path.split('/').length
  const name = pt.basename(path)
  let stats = getFileInfo(path)
  if (stats === null) report('error accessing file => ' + path, true)
  let length = 0 // directory
  const files = []
  if (stats.isFile()) {
    length = stats.size
    files.push({ length: length, path: [path] })
  }
  else if (stats.isDirectory()) {
    const dirs = [path]
    while (dirs.length !== 0) {
      const current = dirs.shift()
      const fls = getFiles(current)
      if (fls === null) report('error accessing file => ' + current, true)
      fls.forEach((f) => {
        const p = current + '/' + f
        const sts = getFileInfo(p)
        if (sts === null) report('error accessing file => ' + p, true)
        if (sts.isFile()) { files.push({ length: sts.size, path: p.split('/') }) }
        else if (sts.isDirectory()) dirs.push(p)
      })
    }
  }
  else report('error path is neither file nor directory => ' + path, true)
  let pieces = Buffer.alloc(0)
  let data = Buffer.alloc(0)
  let i = 0
  getData()

  function getData() {
    fs.createReadStream(files[i].path.join('/'))
    .on('data', (chunk) => {
      data = Buffer.concat([data, chunk])
      if (data.length >= PIECE_LENGTH) {
        update(data.slice(0, PIECE_LENGTH))
        data = Buffer.from(data.slice(PIECE_LENGTH))
      }
    })
    .on('end', () => {
      for (pre = prefix; pre > 0; --pre) files[i].path.shift()
      if (++i === files.length) {
        if (data.length) update(data)
        const info = { name: name, 'piece length': PIECE_LENGTH, pieces: pieces }
        if (length !== 0) info.length = length
        else info.files = files
        const binfo = encode(info)
        const torrFile = Buffer.concat([Buffer.from('d4:info'), binfo, Buffer.from('e')])
        next({ ih: sha1(binfo).toString('hex'), name: name, torrFile: torrFile })
      }
      else process.nextTick(getData)
    })
    .on('error', (err) => { report('error accessing file => ' + files[i].path.join('/'), true) })
    function update(buff) { pieces = Buffer.concat([pieces, sha1(buff)]) }
  }
}
