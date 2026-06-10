import { CfClient } from '../cfbypass.js'

const c = new CfClient(2)

// Test 1: signup
console.log('=== SIGNUP ===')
const r1 = await c.signup('gweber@kilolabs.space', 'Abuhider123@@@')
console.log(JSON.stringify(r1, null, 2))

// Test 2: confirm (separate call)
console.log('\n=== CONFIRM ===')
const r2 = await c.request('https://2no.pl/', { id: 104, query: { email: 'gweber@kilolabs.space', token: 'test' } })
console.log(JSON.stringify(r2, null, 2))

// Test 3: login (separate call)
console.log('\n=== LOGIN ===')
const r3 = await c.login('gweber@kilolabs.space', 'Abuhider123@@@')
console.log(JSON.stringify(r3, null, 2))

c.close()
