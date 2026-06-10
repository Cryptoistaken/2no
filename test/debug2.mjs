import { CfClient } from '../cfbypass.js'
import fs from 'fs'

const c = new CfClient(1)

const origRequest = c.request.bind(c)
c.request = async (url, body, opts = {}) => {
  const result = await origRequest(url, body, opts)
  if (result.error) {
    console.error(`\n*** WORKER ERROR for ${url}: ${result.error}`)
    fs.appendFileSync('B:\\Studio\\Tools\\2no\\test\\errors.log', JSON.stringify({url, body, result}) + '\n')
  }
  return result
}

// Create account first
const email = `${Date.now()}@kilolabs.space`
console.log('Signup...')
const r1 = await c.signup(email, 'Abuhider123@@@')
console.log('Signup:', r1.status, r1.body)

// Confirm with fake token
console.log('\nConfirm...')
const r2 = await c.request('https://2no.pl/', { id: 104, query: { email, token: 'x' } })
console.log('Confirm:', JSON.stringify(r2))

// Login
console.log('\nLogin...')
const r3 = await c.login(email, 'Abuhider123@@@')
console.log('Login:', JSON.stringify(r3))

// Available numbers (no auth)
console.log('\nGetAvailable...')
const r4 = await c.request('https://2no.pl/', { id: 310 })
console.log('Available:', JSON.stringify(r4))

c.close()
