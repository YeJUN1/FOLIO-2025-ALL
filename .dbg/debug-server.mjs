// Minimal Debug Server (Node.js fallback for TRAE-debugger, Python unavailable)
// Implements: POST /event, OPTIONS /event, GET /health, GET /logs, DELETE /logs
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const getArg = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i !== -1 && argv[i + 1] ? argv[i + 1] : def
}
const sessionId = getArg('session', 'default')
const startPort = parseInt(getArg('port', '7777'), 10)
const outdir = path.resolve(getArg('outdir', '.dbg'))
const clean = argv.includes('--clean')
const idle = parseInt(getArg('idle', '0'), 10)
const remote = argv.includes('--remote')

fs.mkdirSync(outdir, { recursive: true })
const logFile = path.join(outdir, `trae-debug-log-${sessionId}.ndjson`)
const envFile = path.join(outdir, `${sessionId}.env`)

if (clean) fs.writeFileSync(logFile, '')

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type',
}

let lastActivity = Date.now()
const startedAt = Date.now()

const server = http.createServer((req, res) => {
    lastActivity = Date.now()
    const url = new URL(req.url, 'http://localhost')

    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        return res.end()
    }

    if (req.method === 'POST' && url.pathname === '/event') {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
            try {
                const event = JSON.parse(body)
                if (typeof event.ts !== 'number') event.ts = Date.now()
                fs.appendFileSync(logFile, JSON.stringify(event) + '\n')
                res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
                res.end('{"ok":true}')
            } catch {
                res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' })
                res.end('{"ok":false}')
            }
        })
        return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
        let count = 0
        try { count = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length } catch {}
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ status: 'ok', sessionId, logFile, count, uptime: (Date.now() - startedAt) / 1000 }))
    }

    if (req.method === 'GET' && url.pathname === '/logs') {
        let lines = []
        try { lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) } catch {}
        const q = url.searchParams
        let items = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
        if (q.get('runId')) items = items.filter((i) => i.runId === q.get('runId'))
        if (q.get('hypothesisId')) items = items.filter((i) => i.hypothesisId === q.get('hypothesisId'))
        const last = parseInt(q.get('last') || '0', 10)
        if (last > 0) items = items.slice(-last)
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(items))
    }

    if (req.method === 'DELETE' && url.pathname === '/logs') {
        fs.writeFileSync(logFile, '')
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        return res.end('{"ok":true}')
    }

    res.writeHead(404, CORS)
    res.end()
})

const host = remote ? '0.0.0.0' : '127.0.0.1'

const listen = (port, retries = 0) => {
    server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && retries < 10) {
            listen(port + 1, retries + 1)
        } else {
            console.error('debug-server error:', err.message)
            process.exit(1)
        }
    })
    server.listen(port, host, () => {
        const apiUrl = `http://${host}:${port}/event`
        fs.writeFileSync(envFile, `DEBUG_SERVER_URL=${apiUrl}\nDEBUG_SESSION_ID=${sessionId}\n`)
        console.log('@@DEBUG_SERVER_INFO')
        console.log(JSON.stringify({
            api_url: apiUrl,
            session_id: sessionId,
            log_dir: outdir,
            log_file: logFile,
            env_file: envFile,
        }, null, 2))
        console.log('@@END_DEBUG_SERVER_INFO')
    })
}

listen(startPort)

if (idle > 0) {
    setInterval(() => {
        if (Date.now() - lastActivity > idle * 1000) {
            console.log('debug-server idle timeout, exiting')
            process.exit(0)
        }
    }, 5000)
}