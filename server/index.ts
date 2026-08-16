import express, { type Response } from 'express'
import cors from 'cors'
import { config } from 'dotenv'
import {
  getEnrichedGroups,
  getLights,
  getSensors,
  setLightState,
  setGroupAction,
  getScenes,
  getSmartScenes,
  activateScene,
  activateSmartScene
} from './hue'
import { getSchedules, setSchedule, startScheduler } from './schedules'
import { requireAuth } from './auth'

config()

const app = express()
const PORT = parseInt(process.env.PORT || '3001', 10)

const hueError = (err: unknown, res: Response) => {
  const msg = err instanceof Error ? err.message : ''
  if (msg === 'HUE_USER_NOT_CONFIGURED') return res.status(503).json({ error: 'not_configured' })
  if (msg === 'HUE_UNAUTHORIZED') return res.status(401).json({ error: 'unauthorized' })
  console.error(err)
  return res.status(500).json({ error: 'internal' })
}

app.use(cors({ exposedHeaders: ['WWW-Authenticate'] }))
app.use('/api', requireAuth)
app.use(express.json())

app.get('/api/groups', async (_req, res) => {
  try {
    const groups = await getEnrichedGroups()
    res.json(groups)
  } catch (err) {
    hueError(err, res)
  }
})

app.get('/api/lights', async (_req, res) => {
  try {
    const lights = await getLights()
    res.json(Object.values(lights))
  } catch (err) {
    hueError(err, res)
  }
})

app.put('/api/lights/:id/state', async (req, res) => {
  try {
    const result = await setLightState(req.params.id, req.body)
    res.json(result)
  } catch (err) {
    hueError(err, res)
  }
})

app.put('/api/groups/:id/state', async (req, res) => {
  try {
    const result = await setGroupAction(req.params.id, req.body)
    res.json(result)
  } catch (err) {
    hueError(err, res)
  }
})

app.get('/api/scenes', async (_req, res) => {
  try {
    const [scenes, smartScenes] = await Promise.all([getScenes(), getSmartScenes()])
    res.json([...scenes, ...smartScenes])
  } catch (err) {
    hueError(err, res)
  }
})

app.put('/api/groups/:id/scene', async (req, res) => {
  try {
    const { sceneId, type } = req.body as { sceneId: string; type: 'static' | 'smart' }
    const result = type === 'smart'
      ? await activateSmartScene(sceneId)
      : await activateScene(req.params.id, sceneId)
    res.json(result)
  } catch (err) {
    hueError(err, res)
  }
})

app.get('/api/sensors', async (_req, res) => {
  try {
    const sensors = await getSensors()
    res.json(
      sensors.map((s) => ({
        id: s.id,
        name: s.name,
        presence: !!s.state.presence,
        lastupdated: s.state.lastupdated ?? ''
      }))
    )
  } catch (err) {
    hueError(err, res)
  }
})

app.put('/api/rooms/:id/kill-switch', async (req, res) => {
  try {
    const { enabled } = req.body as { enabled: boolean }
    const existing = getSchedules()[req.params.id] ?? {
      groupId: req.params.id,
      enabled: false,
      slots: []
    }
    setSchedule(req.params.id, { ...existing, killSwitch: enabled })
    if (enabled) await setGroupAction(req.params.id, { on: false })
    res.json({ ok: true })
  } catch (err) {
    hueError(err, res)
  }
})

app.get('/api/schedules', (_req, res) => {
  try {
    res.json(getSchedules())
  } catch (err) {
    hueError(err, res)
  }
})

app.put('/api/schedules/:groupId', (req, res) => {
  try {
    setSchedule(req.params.groupId, req.body)
    res.json({ ok: true })
  } catch (err) {
    hueError(err, res)
  }
})

app.listen(PORT, () => {
  console.log(`Hue manager server running on http://localhost:${PORT}`)
  startScheduler()
})
