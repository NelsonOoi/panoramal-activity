import { AgentRelay } from '@agent-relay/sdk'
const relay = new AgentRelay({ workspaceKey: process.env.RELAY_WORKSPACE_KEY! })
const sfx = Date.now().toString(36)
const [inv, cam] = await relay.workspace.register([{ name: `c2-inv-${sfx}`, type: 'agent' }, { name: `c2-cam-${sfx}`, type: 'agent' }] as any) as any
const ch = `c2-${sfx}`
await inv.channels.create({ name: ch, topic: 'check' })
await cam.channels.join(ch).catch((e: any) => console.log('join cam', e.message))
let t0 = Date.now(); const T = () => `+${Date.now() - t0}ms`
relay.addListener('*', async (ev: any) => {
  const m = ev.message, env = ev.envelope
  console.log(T(), ev.type, env?.from?.handle ?? env?.from?.name ?? '', env?.channel?.name ?? '', m?.text ?? '')
  if (ev.type === 'message.created' && m?.text?.startsWith('q')) { const r = await cam.reply({ messageId: m.messageId ?? m.id, text: 'testimony' }); console.log(T(), 'reply sent', !!r) }
})
console.log('warmup 6s'); await new Promise(r => setTimeout(r, 6000))
for (let i = 0; i < 3; i++) { t0 = Date.now(); await inv.sendMessage({ to: `#${ch}`, text: `q${i}` }); console.log(T(), 'sent q' + i); await new Promise(r => setTimeout(r, 5000)) }
t0 = Date.now(); await inv.sendMessage({ to: `@c2-cam-${sfx}`, text: 'dm-test' }); console.log(T(), 'sent dm'); await new Promise(r => setTimeout(r, 5000))
process.exit(0)
