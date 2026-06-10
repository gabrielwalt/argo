import { startServer } from './server.js'
import { startCentral } from './central.js'

if (process.env.CENTRAL_MODE === '1') {
  startCentral()
} else {
  startServer().catch(err => { console.error('Server failed to start:', err); process.exit(1) })
}
