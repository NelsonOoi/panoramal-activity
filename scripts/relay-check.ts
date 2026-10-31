import { AgentRelay } from '@agent-relay/sdk'
import { writeFileSync } from 'node:fs'

const relay = new AgentRelay({ workspaceKey: process.env.RELAY_WORKSPACE_KEY! })
const sfx = Date.now().toString(36)

const [inv, cam] = await relay.workspace.register([{ name: `check-inv-${sfx}`, type: 'agent' }, { name: `check-cam-${sfx}`, type: 'agent' }] as any) as any
await inv.channels.create({ name: 'check-room', topic: 'check' }).catch((e: any) => console.log('create', e.message))
await inv.channels.join('check-room').catch((e: any) => console.log('join inv', e.message))
await cam.channels.join('check-room').catch((e: any) => console.log('join cam', e.message))

let t0 = 0
const done = new Promise<void>(resolve => {
  relay.addListener('message.created', async ({ message, envelope }: any) => {
    const from = envelope.from?.handle ?? envelope.from?.name
    console.log(`+${Date.now() - t0}ms`, 'from', from, 'channel', envelope.channel?.name, 'thread', message.threadId ?? message.parentId, 'text', message.text)
    if (from?.includes(`check-inv-${sfx}`)) await cam.reply({ messageId: message.messageId ?? message.id, text: 'testimony: saw it' })
    else resolve()
  })
})
await new Promise(r => setTimeout(r, 1500))
t0 = Date.now()
await inv.sendMessage({ to: '#check-room', text: 'question: what happened?' })
await Promise.race([done, new Promise(r => setTimeout(r, 15000))])
console.log('total', Date.now() - t0, 'ms')
process.exit(0)
