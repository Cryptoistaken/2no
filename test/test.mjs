import { CfClient } from '../cfbypass.js'

const client = new CfClient(2)

console.log('=== Signup (id:103) ===')
const r1 = await client.signup('gweber@kilolabs.space', 'Abuhider123@@@')
console.log(`Status: ${r1.status}, Body: ${r1.body}`)

console.log('\n=== Login (id:101) ===')
const r2 = await client.login('gweber@kilolabs.space', 'Abuhider123@@@')
console.log(`Status: ${r2.status}, Body: ${r2.body}`)

client.close()
